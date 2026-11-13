// SPDX-License-Identifier: GPL-3.0-or-later
// Tests first-page.h, the drawing half of Inkleaf's Explorer thumbnails, on
// any system with a PDFium library (tests/thumbnails.mjs supplies one).
//   test-first-page <libpdfium> <pdf> <size> <out.ppm>
// Prints "OK <width>x<height>" and writes the picture, or prints "NOPICTURE".
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <dlfcn.h>
#include "first-page.h"

int main(int argc, char **argv) {
    if (argc < 5) return 2;
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { printf("FAIL %s\n", dlerror()); return 1; }
    firstpage::Pdfium pdfium;
    if (!firstpage::load(pdfium, [lib](const char *name) { return dlsym(lib, name); })) { printf("FAIL functions\n"); return 1; }

    FILE *in = fopen(argv[2], "rb");
    if (!in) { printf("FAIL open\n"); return 1; }
    std::vector<unsigned char> data;
    unsigned char chunk[65536];
    size_t n;
    while ((n = fread(chunk, 1, sizeof chunk, in)) > 0) data.insert(data.end(), chunk, chunk + n);
    fclose(in);

    if (!firstpage::looksLikePdf(data.data(), data.size())) { printf("NOPICTURE not a pdf\n"); return 0; }
    std::vector<unsigned char> pixels;
    int w = 0, h = 0;
    bool ok = firstpage::draw(pdfium, data.data(), data.size(), static_cast<unsigned>(atoi(argv[3])), [&](int width, int height) -> void * {
        w = width;
        h = height;
        pixels.assign(static_cast<size_t>(width) * height * 4, 0);
        return pixels.data();
    });
    if (!ok) { printf("NOPICTURE\n"); return 0; }

    FILE *out = fopen(argv[4], "wb");
    fprintf(out, "P6\n%d %d\n255\n", w, h);
    for (size_t i = 0; i < pixels.size(); i += 4) {
        unsigned char rgb[3] = { pixels[i + 2], pixels[i + 1], pixels[i] };
        fwrite(rgb, 1, 3, out);
    }
    fclose(out);
    printf("OK %dx%d\n", w, h);
    return 0;
}
