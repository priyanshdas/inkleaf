// SPDX-License-Identifier: GPL-3.0-or-later
// The phone's built-in AI, the native half. InkleafAi.kt loads a model with
// load(), asks it things with generate(), and lets go of it with free().
//
// One model is held at a time, and one answer is worked on at a time (the
// Kotlin side makes sure of that). Text goes in and out as UTF-8 bytes; a
// character split across two tokens is held back until it's whole, so the
// other side never sees half of one.

#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <atomic>
#include <string>
#include <vector>

#define TAG "InkleafAi"
#define LOG(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

#ifdef INKLEAF_AI_STUB

// Phones other than 64-bit ARM: the model isn't built in, so say so.
extern "C" {
JNIEXPORT jboolean JNICALL Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeSupported(JNIEnv *, jclass, jstring) { return JNI_FALSE; }
JNIEXPORT jlong JNICALL Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeLoad(JNIEnv *, jclass, jstring, jint, jint) { return 0; }
JNIEXPORT jint JNICALL Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeGenerate(JNIEnv *, jclass, jlong, jbyteArray, jint, jobject) { return -1; }
JNIEXPORT void JNICALL Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeStop(JNIEnv *, jclass, jlong) {}
JNIEXPORT void JNICALL Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeFree(JNIEnv *, jclass, jlong) {}
}

#else

#include "ggml-backend.h"
#include "llama.h"

namespace {

struct Session {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    const llama_vocab *vocab = nullptr;
    std::atomic<bool> stop{false};
};

bool backends_loaded = false;

void quiet_log(ggml_log_level level, const char *text, void *) {
    // warnings and errors only (not the progress dots printed while a model loads)
    if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR) __android_log_print(ANDROID_LOG_WARN, TAG, "%s", text);
}

/** How many bytes at the end of `s` are the start of a character that hasn't finished yet. */
size_t unfinished_tail(const std::string &s) {
    size_t n = s.size();
    for (size_t back = 1; back <= 4 && back <= n; back++) {
        unsigned char c = static_cast<unsigned char>(s[n - back]);
        if ((c & 0xC0) == 0x80) continue; // a continuation byte: keep looking for the lead byte
        size_t need = (c & 0x80) == 0 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        return need > back ? back : 0;
    }
    return 0;
}

} // namespace

extern "C" {

/** Finds the CPU code best suited to this phone (the app ships several). False if none will run. */
JNIEXPORT jboolean JNICALL
Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeSupported(JNIEnv *env, jclass, jstring lib_dir) {
    if (!backends_loaded) {
        llama_log_set(quiet_log, nullptr);
        const char *dir = env->GetStringUTFChars(lib_dir, nullptr);
        ggml_backend_load_all_from_path(dir);
        env->ReleaseStringUTFChars(lib_dir, dir);
        llama_backend_init();
        backends_loaded = true;
    }
    return ggml_backend_dev_count() > 0 ? JNI_TRUE : JNI_FALSE;
}

/** Loads a model. Returns a handle, or 0 if it couldn't. */
JNIEXPORT jlong JNICALL
Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeLoad(JNIEnv *env, jclass, jstring path, jint n_ctx, jint n_threads) {
    const char *file = env->GetStringUTFChars(path, nullptr);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    llama_model *model = llama_model_load_from_file(file, mp);
    env->ReleaseStringUTFChars(path, file);
    if (!model) return 0;

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = static_cast<uint32_t>(n_ctx);
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_seq_max = 1;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) {
        llama_model_free(model);
        return 0;
    }
    auto *s = new Session();
    s->model = model;
    s->ctx = ctx;
    s->vocab = llama_model_get_vocab(model);
    // checked between steps of reading the prompt, so Stop works then too
    llama_set_abort_callback(ctx, [](void *data) { return static_cast<Session *>(data)->stop.load(); }, s);
    LOG("model loaded, %d threads, context %d", n_threads, n_ctx);
    return reinterpret_cast<jlong>(s);
}

/**
 * Writes an answer to `prompt` (already in the model's chat format), handing
 * each new piece to `sink.piece(byte[])`, which returns false to stop early.
 * Returns how many tokens were written, -2 if the prompt doesn't fit, or -1
 * if something else went wrong.
 */
JNIEXPORT jint JNICALL
Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeGenerate(JNIEnv *env, jclass, jlong handle, jbyteArray prompt_bytes, jint max_tokens, jobject sink) {
    auto *s = reinterpret_cast<Session *>(handle);
    if (!s) return -1;
    s->stop = false;

    jclass sink_class = env->GetObjectClass(sink);
    jmethodID piece = env->GetMethodID(sink_class, "piece", "([B)Z");
    if (!piece) return -1;

    const jsize length = env->GetArrayLength(prompt_bytes);
    std::string prompt(static_cast<size_t>(length), '\0');
    env->GetByteArrayRegion(prompt_bytes, 0, length, reinterpret_cast<jbyte *>(prompt.data()));

    // a fresh start for every question
    llama_memory_clear(llama_get_memory(s->ctx), true);

    int n = -llama_tokenize(s->vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> tokens(static_cast<size_t>(n));
    if (llama_tokenize(s->vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), tokens.data(), n, true, true) < 0) return -1;
    // a long prompt leaves less room to answer; too little room isn't worth starting
    const int n_ctx = static_cast<int>(llama_n_ctx(s->ctx));
    max_tokens = std::min(max_tokens, n_ctx - n);
    if (max_tokens < 128) return -2;

    // read the prompt in batches
    const int n_batch = static_cast<int>(llama_n_batch(s->ctx));
    for (int i = 0; i < n; i += n_batch) {
        const int count = std::min(n_batch, n - i);
        if (llama_decode(s->ctx, llama_batch_get_one(tokens.data() + i, count)) != 0) {
            return s->stop ? 0 : -1;
        }
    }

    // Qwen's suggested settings for answers without thinking
    llama_sampler *sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_top_k(20));
    // a light touch against repeating itself, applied after top-k so it stays quick
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(llama_vocab_n_tokens(s->vocab), 64, 1.05f, 0.0f, 0.0f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.8f, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    std::string pending;
    int written = 0;
    char buf[256];
    bool go_on = true;
    auto send = [&](const std::string &text) {
        jbyteArray out = env->NewByteArray(static_cast<jsize>(text.size()));
        env->SetByteArrayRegion(out, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte *>(text.data()));
        go_on = env->CallBooleanMethod(sink, piece, out) == JNI_TRUE;
        env->DeleteLocalRef(out);
        if (env->ExceptionCheck()) go_on = false;
    };

    while (written < max_tokens && go_on && !s->stop) {
        llama_token token = llama_sampler_sample(sampler, s->ctx, -1);
        if (llama_vocab_is_eog(s->vocab, token)) break;
        const int len = llama_token_to_piece(s->vocab, token, buf, sizeof buf, 0, false);
        if (len > 0) pending.append(buf, static_cast<size_t>(len));
        written++;
        const size_t hold = unfinished_tail(pending);
        if (pending.size() > hold) {
            send(pending.substr(0, pending.size() - hold));
            pending.erase(0, pending.size() - hold);
        }
        if (llama_decode(s->ctx, llama_batch_get_one(&token, 1)) != 0) break;
    }
    if (!pending.empty() && go_on) send(pending);
    llama_sampler_free(sampler);
    return written;
}

JNIEXPORT void JNICALL
Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeStop(JNIEnv *, jclass, jlong handle) {
    auto *s = reinterpret_cast<Session *>(handle);
    if (s) s->stop = true;
}

JNIEXPORT void JNICALL
Java_io_github_priyanshdas_inkleaf_InkleafAi_nativeFree(JNIEnv *, jclass, jlong handle) {
    auto *s = reinterpret_cast<Session *>(handle);
    if (!s) return;
    llama_free(s->ctx);
    llama_model_free(s->model);
    delete s;
}

} // extern "C"

#endif
