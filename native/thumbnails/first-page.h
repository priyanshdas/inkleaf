// SPDX-License-Identifier: GPL-3.0-or-later
// Draws a PDF's first page with PDFium. Kept apart from the Windows parts
// (inkleaf-thumbs.cpp) so the same code can be tested on any system
// (test-first-page.cpp).
//
// PDFium is loaded at run time, so nothing needs linking against it; the
// caller says how to look up each of its functions.

#pragma once

#include <cstddef>
#include <type_traits>

namespace firstpage {

typedef void *Doc;
typedef void *Page;
typedef void *Bitmap;

struct Pdfium {
    void (*InitLibrary)();
    Doc (*LoadMemDocument)(const void *data, int size, const char *password);
    void (*CloseDocument)(Doc);
    int (*GetPageCount)(Doc);
    Page (*LoadPage)(Doc, int index);
    void (*ClosePage)(Page);
    float (*GetPageWidthF)(Page);
    float (*GetPageHeightF)(Page);
    Bitmap (*BitmapCreateEx)(int width, int height, int format, void *first_scan, int stride);
    int (*BitmapFillRect)(Bitmap, int left, int top, int width, int height, unsigned long color);
    void (*BitmapDestroy)(Bitmap);
    void (*RenderPageBitmap)(Bitmap, Page, int x, int y, int width, int height, int rotate, int flags);
};

const int BGRA = 4;
const int DRAW_ANNOTATIONS = 0x01;

/** Fills in every function from `lookup`, then starts PDFium. False if any is missing. */
template <typename Lookup> bool load(Pdfium &p, Lookup lookup) {
    auto find = [&](auto &out, const char *name) {
        out = reinterpret_cast<std::remove_reference_t<decltype(out)>>(lookup(name));
        return out != nullptr;
    };
    bool ok = find(p.InitLibrary, "FPDF_InitLibrary")
        && find(p.LoadMemDocument, "FPDF_LoadMemDocument")
        && find(p.CloseDocument, "FPDF_CloseDocument")
        && find(p.GetPageCount, "FPDF_GetPageCount")
        && find(p.LoadPage, "FPDF_LoadPage")
        && find(p.ClosePage, "FPDF_ClosePage")
        && find(p.GetPageWidthF, "FPDF_GetPageWidthF")
        && find(p.GetPageHeightF, "FPDF_GetPageHeightF")
        && find(p.BitmapCreateEx, "FPDFBitmap_CreateEx")
        && find(p.BitmapFillRect, "FPDFBitmap_FillRect")
        && find(p.BitmapDestroy, "FPDFBitmap_Destroy")
        && find(p.RenderPageBitmap, "FPDF_RenderPageBitmap");
    if (ok) p.InitLibrary();
    return ok;
}

/** True if a PDF's header is in the first kilobyte (it isn't always at the very start). */
inline bool looksLikePdf(const unsigned char *data, size_t length) {
    for (size_t i = 0; i + 5 <= length && i < 1024; i++) {
        if (data[i] == '%' && data[i + 1] == 'P' && data[i + 2] == 'D' && data[i + 3] == 'F' && data[i + 4] == '-') return true;
    }
    return false;
}

/**
 * Draws page one of the PDF in `data`, `size` pixels along its longer side.
 * `pixels(width, height)` is called once the size is known and returns
 * where to draw: 32-bit BGRA rows, top first, `width * 4` bytes each (or
 * null to give up). Returns false if the PDF can't be read.
 */
template <typename Pixels> bool draw(const Pdfium &p, const unsigned char *data, size_t length, unsigned size, Pixels pixels) {
    if (length == 0 || length > 0x7fffffff || size == 0) return false;
    Doc doc = p.LoadMemDocument(data, static_cast<int>(length), nullptr);
    if (!doc) return false;
    bool done = false;
    Page page = p.GetPageCount(doc) > 0 ? p.LoadPage(doc, 0) : nullptr;
    if (page) {
        float w = p.GetPageWidthF(page), h = p.GetPageHeightF(page);
        if (w > 0 && h > 0) {
            float scale = static_cast<float>(size) / (w > h ? w : h);
            int width = static_cast<int>(w * scale + 0.5f), height = static_cast<int>(h * scale + 0.5f);
            if (width < 1) width = 1;
            if (height < 1) height = 1;
            void *target = pixels(width, height);
            if (target) {
                Bitmap bitmap = p.BitmapCreateEx(width, height, BGRA, target, width * 4);
                if (bitmap) {
                    // white paper first: most PDFs leave the page itself see-through
                    p.BitmapFillRect(bitmap, 0, 0, width, height, 0xFFFFFFFFul);
                    p.RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, DRAW_ANNOTATIONS);
                    p.BitmapDestroy(bitmap);
                    done = true;
                }
            }
        }
        p.ClosePage(page);
    }
    p.CloseDocument(doc);
    return done;
}

} // namespace firstpage
