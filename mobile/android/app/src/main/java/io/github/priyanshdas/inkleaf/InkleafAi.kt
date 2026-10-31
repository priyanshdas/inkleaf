// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The phone's built-in AI: downloads a model, checks it, and runs it with
 * llama.cpp (src/main/cpp/inkleaf-ai.cpp) right on the phone. Nothing about
 * the document leaves the phone.
 *
 * Models live in the app's own storage (files/ai), so they go when the app
 * is uninstalled. A download that's interrupted picks up where it stopped.
 */
object InkleafAi {

    /** Something to hand the answer to, a piece at a time. Return false to stop. */
    fun interface Sink { fun piece(bytes: ByteArray): Boolean }

    // --- the native half ------------------------------------------------------------------------

    private val loaded: Boolean = try {
        System.loadLibrary("inkleaf-ai")
        true
    } catch (_: Throwable) {
        false
    }

    @JvmStatic private external fun nativeSupported(libDir: String): Boolean
    @JvmStatic private external fun nativeLoad(path: String, context: Int, threads: Int): Long
    @JvmStatic private external fun nativeGenerate(handle: Long, prompt: ByteArray, maxTokens: Int, sink: Sink): Int
    @JvmStatic private external fun nativeStop(handle: Long)
    @JvmStatic private external fun nativeFree(handle: Long)

    private var supportedCache: Boolean? = null

    /** Whether this phone can run the model: 64-bit ARM, and enough memory. */
    fun supported(context: Context): Boolean {
        supportedCache?.let { return it }
        val ok = loaded && try {
            nativeSupported(context.applicationInfo.nativeLibraryDir)
        } catch (_: Throwable) {
            false
        }
        supportedCache = ok
        return ok
    }

    // --- running ----------------------------------------------------------------------------------

    private val lock = Object()
    private var handle = 0L
    private var handleFile: String? = null
    private var handleContext = 0
    @Volatile private var running = 0L
    private val idle = Handler(Looper.getMainLooper())
    private val release = Runnable { synchronized(lock) { unload() } }

    /** Same idea as the computer app: let go of the model after five quiet minutes. */
    private const val IDLE_MS = 5 * 60 * 1000L

    private fun unload() {
        if (handle != 0L) nativeFree(handle)
        handle = 0L
        handleFile = null
    }

    private fun threads(): Int {
        // leave the little cores (and the screen) some room
        val cores = Runtime.getRuntime().availableProcessors()
        return (cores - 2).coerceIn(2, 4)
    }

    /**
     * Writes an answer. Blocks, so call it off the main thread. Returns the
     * number of tokens written; throws with a short reason if it couldn't.
     */
    fun generate(context: Context, file: String, prompt: String, contextSize: Int, maxTokens: Int, sink: Sink): Int {
        if (!supported(context)) throw IllegalStateException("unsupported")
        val model = modelFile(context, file)
        if (!model.exists()) throw IllegalStateException("missing")
        synchronized(lock) {
            idle.removeCallbacks(release)
            try {
                if (handle == 0L || handleFile != file || handleContext != contextSize) {
                    unload()
                    handle = nativeLoad(model.absolutePath, contextSize, threads())
                    if (handle == 0L) throw IllegalStateException("load")
                    handleFile = file
                    handleContext = contextSize
                }
                running = handle
                val written = nativeGenerate(handle, prompt.toByteArray(Charsets.UTF_8), maxTokens, sink)
                when (written) {
                    -2 -> throw IllegalStateException("too-long")
                    -1 -> throw IllegalStateException("failed")
                }
                return written
            } finally {
                running = 0L
                idle.postDelayed(release, IDLE_MS)
            }
        }
    }

    fun stop() {
        val h = running
        if (h != 0L) nativeStop(h)
    }

    // --- downloading ------------------------------------------------------------------------------

    class Download(val file: String, @Volatile var received: Long, val total: Long) {
        @Volatile var cancelled = false
    }

    @Volatile var downloading: Download? = null
        private set

    private fun folder(context: Context) = File(context.filesDir, "ai/models").apply { mkdirs() }
    fun modelFile(context: Context, file: String) = File(folder(context), File(file).name)

    fun installed(context: Context, files: List<String>) = files.filter { modelFile(context, it).exists() }

    /** Bytes still to download for a model (less if part of it is already here). */
    fun remaining(context: Context, file: String, size: Long): Long {
        if (modelFile(context, file).exists()) return 0
        val part = File(folder(context), File(file).name + ".part")
        return (size - part.length()).coerceAtLeast(0)
    }

    fun freeSpace(context: Context): Long = context.filesDir.usableSpace

    fun remove(context: Context, file: String) {
        synchronized(lock) {
            if (handleFile == file) unload()
        }
        modelFile(context, file).delete()
        File(folder(context), File(file).name + ".part").delete()
    }

    fun cancelDownload() {
        downloading?.cancelled = true
    }

    /**
     * Downloads a model and checks its SHA-256. Blocks; call it off the main
     * thread. `progress` is told how far it's got every so often.
     */
    fun download(context: Context, file: String, url: String, sha256: String, size: Long, progress: (Long, Long) -> Unit) {
        val target = modelFile(context, file)
        if (target.exists()) return
        if (downloading != null) throw IllegalStateException("busy")
        val part = File(folder(context), target.name + ".part")
        // room for it, plus a little to spare
        if (freeSpace(context) < (size - part.length()) + 200L * 1024 * 1024) throw IllegalStateException("space")
        val job = Download(file, part.length(), size)
        downloading = job
        try {
            if (part.length() < size) fetch(url, part, size, job, progress)
            progress(part.length(), size)
            if (part.length() != size || sha256Of(part) != sha256.lowercase()) {
                part.delete()
                throw IllegalStateException("checksum")
            }
            if (!part.renameTo(target)) throw IllegalStateException("failed")
        } finally {
            downloading = null
        }
    }

    private fun fetch(url: String, part: File, size: Long, job: Download, progress: (Long, Long) -> Unit) {
        var address = URL(url)
        var connection: HttpURLConnection
        // follow redirects ourselves (Hugging Face sends files from another host)
        var hops = 0
        while (true) {
            connection = address.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20_000
            connection.readTimeout = 60_000
            connection.setRequestProperty("User-Agent", "Inkleaf")
            if (part.length() > 0) connection.setRequestProperty("Range", "bytes=${part.length()}-")
            val code = connection.responseCode
            if (code in 300..399 && hops++ < 6) {
                address = URL(address, connection.getHeaderField("Location"))
                connection.disconnect()
                continue
            }
            break
        }
        val code = connection.responseCode
        val resume = code == 206
        if (code != 200 && !resume) throw IllegalStateException("http $code")
        RandomAccessFile(part, "rw").use { out ->
            if (resume) out.seek(part.length()) else out.setLength(0)
            job.received = out.filePointer
            connection.inputStream.use { input ->
                val buffer = ByteArray(256 * 1024)
                var last = 0L
                while (true) {
                    if (job.cancelled) throw IllegalStateException("cancelled")
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    job.received += n
                    val now = System.currentTimeMillis()
                    if (now - last > 250) {
                        last = now
                        progress(job.received, size)
                    }
                }
            }
        }
        connection.disconnect()
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
