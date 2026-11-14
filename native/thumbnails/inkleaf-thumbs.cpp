// SPDX-License-Identifier: GPL-3.0-or-later
// Inkleaf's PDF thumbnails and preview pane for File Explorer on Windows.
//
// Explorer asks the app that opens a file type for its pictures of those
// files, and for something to show in the preview pane. Once Inkleaf opens
// PDFs, this is what Explorer asks. Both draw with PDFium (the PDF engine
// in Chrome), which sits next to this DLL as pdfium.dll:
//
// - thumbnails: the first page of each PDF;
// - the preview pane: every page, one under the other, fitted to the
//   pane's width, scrolled with the mouse wheel, the scroll bar or the keys.
//
// Explorer runs these in separate processes and may call them from several
// threads, so PDFium, which isn't thread-safe, is used by one call at a time.
// A PDF that can't be read (damaged, or locked with a password) gets no
// thumbnail (Explorer shows Inkleaf's icon) and no preview (Explorer says it
// can't preview it).
//
// Registered by the installer (build/installer.nsh) and by the Microsoft
// Store package (build/appx-manifest.js) under INKLEAF_THUMBNAILS and
// INKLEAF_PREVIEW below.

#include <windows.h>
#include <new>
#include <shlwapi.h>
#include <propsys.h>
#include <thumbcache.h>
#include <shobjidl.h>
#include <ocidl.h>
#include <vector>

#include "first-page.h"

// {1EBEB7F8-27A7-4B2A-A890-88C35591D436}
static const CLSID INKLEAF_THUMBNAILS = { 0x1ebeb7f8, 0x27a7, 0x4b2a, { 0xa8, 0x90, 0x88, 0xc3, 0x55, 0x91, 0xd4, 0x36 } };

// {426761B5-11FE-448D-8071-7EAC4FBFAED9}
static const CLSID INKLEAF_PREVIEW = { 0x426761b5, 0x11fe, 0x448d, { 0x80, 0x71, 0x7e, 0xac, 0x4f, 0xbf, 0xae, 0xd9 } };

// The interfaces' own ids, spelled out because not every set of Windows
// headers ships them in a library. IThumbnailProvider's is also the
// "thumbnail" key under a file type's ShellEx, and IPreviewHandler's the
// "preview" one. (also the "thumbnail" key under a file type's ShellEx);
// spelled out because not every set of Windows headers ships it in a library
static const IID THUMBNAIL_PROVIDER = { 0xe357fccd, 0xa995, 0x4576, { 0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96 } };
static const IID PREVIEW_HANDLER = { 0x8895b1c6, 0xb41f, 0x4c1c, { 0xa5, 0x62, 0x0d, 0x56, 0x42, 0x50, 0x83, 0x6f } };
static const IID PREVIEW_HANDLER_FRAME = { 0xfec87aaf, 0x35f9, 0x447a, { 0xad, 0xb7, 0x20, 0x23, 0x44, 0x91, 0x40, 0x1a } };
static const IID PREVIEW_HANDLER_VISUALS = { 0x196bf9a5, 0xb346, 0x4ef0, { 0xaa, 0x1e, 0x5d, 0xcd, 0xb7, 0x67, 0x68, 0xb1 } };
static const IID OBJECT_WITH_SITE = { 0xfc4801a3, 0x2ba9, 0x11cf, { 0xa2, 0x29, 0x00, 0xaa, 0x00, 0x3d, 0x73, 0x52 } };
static const IID OLE_WINDOW = { 0x00000114, 0x0000, 0x0000, { 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };

static HMODULE self = nullptr;
static LONG objects = 0;
static LONG locks = 0;

// --- PDFium, loaded from beside this DLL ---------------------------------------------------------

static firstpage::Pdfium pdfium;
static SRWLOCK pdfiumLock = SRWLOCK_INIT;
static bool pdfiumLoaded = false;
static bool pdfiumFailed = false;

/** Loads pdfium.dll from this DLL's own folder. Call with the lock held. */
static bool loadPdfium() {
    if (pdfiumLoaded) return true;
    if (pdfiumFailed) return false;
    pdfiumFailed = true;
    wchar_t path[MAX_PATH * 2];
    DWORD n = GetModuleFileNameW(self, path, ARRAYSIZE(path));
    if (n == 0 || n >= ARRAYSIZE(path)) return false;
    PathRemoveFileSpecW(path);
    if (!PathAppendW(path, L"pdfium.dll")) return false;
    HMODULE dll = LoadLibraryExW(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!dll) return false;
    if (!firstpage::load(pdfium, [dll](const char *name) { return reinterpret_cast<void *>(GetProcAddress(dll, name)); })) {
        FreeLibrary(dll);
        return false;
    }
    pdfiumFailed = false;
    pdfiumLoaded = true;
    return true;
}

/** A 32-bit top-down bitmap that PDFium can draw straight into. */
static HBITMAP makeBitmap(int width, int height, void **bits) {
    BITMAPINFO info = {};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    *bits = nullptr;
    HBITMAP dib = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, bits, nullptr, 0);
    if (dib && !*bits) {
        DeleteObject(dib);
        return nullptr;
    }
    return dib;
}

/** The first page of `data`, `size` pixels on its longer side, as a bitmap for Explorer. */
static HRESULT drawFirstPage(const BYTE *data, DWORD length, UINT size, HBITMAP *out) {
    // PDFium isn't thread-safe, and Explorer may ask from several threads
    AcquireSRWLockExclusive(&pdfiumLock);
    HBITMAP dib = nullptr;
    bool drawn = loadPdfium() && firstpage::draw(pdfium, data, length, size, [&dib](int width, int height) -> void * {
        void *bits = nullptr;
        dib = makeBitmap(width, height, &bits);
        return bits;
    });
    ReleaseSRWLockExclusive(&pdfiumLock);
    if (!drawn) {
        if (dib) DeleteObject(dib);
        return E_FAIL;
    }
    *out = dib;
    return S_OK;
}

/** Reads a whole PDF from the stream Explorer hands over (PDFium needs to jump about in it). */
static HRESULT readPdf(IStream *stream, BYTE **data, DWORD *length) {
    if (!stream) return E_INVALIDARG;
    STATSTG stat = {};
    if (FAILED(stream->Stat(&stat, STATFLAG_NONAME))) return E_FAIL;
    // a picture isn't worth reading half a gigabyte for
    const ULONGLONG limit = 512ull * 1024 * 1024;
    if (stat.cbSize.QuadPart == 0 || stat.cbSize.QuadPart > limit) return E_FAIL;
    DWORD size = static_cast<DWORD>(stat.cbSize.QuadPart);
    BYTE *buffer = static_cast<BYTE *>(HeapAlloc(GetProcessHeap(), 0, size));
    if (!buffer) return E_OUTOFMEMORY;
    DWORD got = 0;
    while (got < size) {
        ULONG read = 0;
        HRESULT hr = stream->Read(buffer + got, size - got, &read);
        if (FAILED(hr) || read == 0) break;
        got += read;
    }
    if (!firstpage::looksLikePdf(buffer, got)) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return E_FAIL;
    }
    *data = buffer;
    *length = got;
    return S_OK;
}

// --- the thumbnail maker Explorer talks to ------------------------------------------------------

class Thumbnails final : public IInitializeWithStream, public IThumbnailProvider {
    LONG refs = 1;
    BYTE *data = nullptr;
    DWORD length = 0;

  public:
    Thumbnails() { InterlockedIncrement(&objects); }
    ~Thumbnails() {
        if (data) HeapFree(GetProcessHeap(), 0, data);
        InterlockedDecrement(&objects);
    }

    // IUnknown
    IFACEMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (riid == IID_IUnknown || riid == IID_IInitializeWithStream) *out = static_cast<IInitializeWithStream *>(this);
        else if (riid == THUMBNAIL_PROVIDER) *out = static_cast<IThumbnailProvider *>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
    IFACEMETHODIMP_(ULONG) Release() override {
        LONG left = InterlockedDecrement(&refs);
        if (!left) delete this;
        return left;
    }

    // IInitializeWithStream
    IFACEMETHODIMP Initialize(IStream *stream, DWORD) override {
        if (data) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        return readPdf(stream, &data, &length);
    }

    // IThumbnailProvider
    IFACEMETHODIMP GetThumbnail(UINT size, HBITMAP *bitmap, WTS_ALPHATYPE *alpha) override {
        if (!bitmap || !alpha) return E_POINTER;
        *bitmap = nullptr;
        *alpha = WTSAT_RGB;
        if (!data || size == 0) return E_UNEXPECTED;
        return drawFirstPage(data, length, size > 2048 ? 2048 : size, bitmap);
    }
};

// --- the preview pane ------------------------------------------------------------------------------

const wchar_t PREVIEW_CLASS[] = L"InkleafPdfPreview";

class Preview final : public IPreviewHandler, public IInitializeWithStream, public IObjectWithSite, public IOleWindow, public IPreviewHandlerVisuals {
    LONG refs = 1;
    BYTE *data = nullptr;
    DWORD length = 0;
    IUnknown *site = nullptr;
    IPreviewHandlerFrame *frame = nullptr;
    HWND parent = nullptr;
    HWND window = nullptr;
    RECT bounds = {};
    COLORREF background = RGB(240, 240, 240);
    firstpage::Doc doc = nullptr;

    // the pages, laid out one under the other at the pane's width (pixels)
    std::vector<double> widths, heights; // in points
    std::vector<int> tops, sizesX, sizesY;
    int total = 0;
    int scroll = 0;

    // the last few pages drawn, kept so scrolling back and forth stays quick
    struct Drawn { int page; HBITMAP bitmap; unsigned long used; };
    std::vector<Drawn> drawn;
    unsigned long clock = 0;

  public:
    Preview() { InterlockedIncrement(&objects); }
    ~Preview() {
        Unload();
        SetSite(nullptr);
        InterlockedDecrement(&objects);
    }

    // IUnknown
    IFACEMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (riid == IID_IUnknown || riid == PREVIEW_HANDLER) *out = static_cast<IPreviewHandler *>(this);
        else if (riid == IID_IInitializeWithStream) *out = static_cast<IInitializeWithStream *>(this);
        else if (riid == OBJECT_WITH_SITE) *out = static_cast<IObjectWithSite *>(this);
        else if (riid == OLE_WINDOW) *out = static_cast<IOleWindow *>(this);
        else if (riid == PREVIEW_HANDLER_VISUALS) *out = static_cast<IPreviewHandlerVisuals *>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
    IFACEMETHODIMP_(ULONG) Release() override {
        LONG left = InterlockedDecrement(&refs);
        if (!left) delete this;
        return left;
    }

    // IInitializeWithStream
    IFACEMETHODIMP Initialize(IStream *stream, DWORD) override {
        if (data) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        return readPdf(stream, &data, &length);
    }

    // IObjectWithSite: where Explorer's preview pane is, for passing on its shortcut keys
    IFACEMETHODIMP SetSite(IUnknown *next) override {
        if (frame) frame->Release();
        if (site) site->Release();
        frame = nullptr;
        site = next;
        if (site) {
            site->AddRef();
            site->QueryInterface(PREVIEW_HANDLER_FRAME, reinterpret_cast<void **>(&frame));
        }
        return S_OK;
    }
    IFACEMETHODIMP GetSite(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        return site ? site->QueryInterface(riid, out) : E_FAIL;
    }

    // IOleWindow
    IFACEMETHODIMP GetWindow(HWND *out) override {
        if (!out) return E_POINTER;
        *out = window ? window : parent;
        return *out ? S_OK : E_FAIL;
    }
    IFACEMETHODIMP ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }

    // IPreviewHandlerVisuals: Explorer's own colours, light or dark
    IFACEMETHODIMP SetBackgroundColor(COLORREF colour) override {
        background = colour;
        if (window) InvalidateRect(window, nullptr, FALSE);
        return S_OK;
    }
    IFACEMETHODIMP SetFont(const LOGFONTW *) override { return S_OK; }
    IFACEMETHODIMP SetTextColor(COLORREF) override { return S_OK; }

    // IPreviewHandler
    IFACEMETHODIMP SetWindow(HWND hwnd, const RECT *rect) override {
        if (!hwnd || !rect) return E_INVALIDARG;
        parent = hwnd;
        bounds = *rect;
        if (window) {
            ::SetParent(window, parent);
            place();
        }
        return S_OK;
    }
    IFACEMETHODIMP SetRect(const RECT *rect) override {
        if (!rect) return E_INVALIDARG;
        bounds = *rect;
        if (window) place();
        return S_OK;
    }
    IFACEMETHODIMP DoPreview() override {
        if (window) return S_OK;
        if (!data || !parent) return E_UNEXPECTED;
        AcquireSRWLockExclusive(&pdfiumLock);
        bool ok = loadPdfium();
        if (ok) doc = firstpage::open(pdfium, data, length);
        int count = doc ? pdfium.GetPageCount(doc) : 0;
        for (int i = 0; i < count; i++) {
            double w = 0, h = 0;
            if (!firstpage::pageSize(pdfium, doc, i, w, h)) w = 612, h = 792;
            widths.push_back(w);
            heights.push_back(h);
        }
        ReleaseSRWLockExclusive(&pdfiumLock);
        if (!doc || count < 1) {
            Unload();
            return E_FAIL; // Explorer then says it can't preview the file
        }
        registerClass();
        window = CreateWindowExW(0, PREVIEW_CLASS, nullptr, WS_CHILD | WS_VSCROLL | WS_CLIPSIBLINGS,
            bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, parent, nullptr, self, this);
        if (!window) {
            Unload();
            return HRESULT_FROM_WIN32(GetLastError());
        }
        layout();
        ShowWindow(window, SW_SHOW);
        return S_OK;
    }
    IFACEMETHODIMP Unload() override {
        if (window) {
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            DestroyWindow(window);
            window = nullptr;
        }
        forget();
        if (doc) {
            AcquireSRWLockExclusive(&pdfiumLock);
            pdfium.CloseDocument(doc);
            ReleaseSRWLockExclusive(&pdfiumLock);
            doc = nullptr;
        }
        if (data) HeapFree(GetProcessHeap(), 0, data);
        data = nullptr;
        length = 0;
        widths.clear();
        heights.clear();
        return S_OK;
    }
    IFACEMETHODIMP SetFocus() override {
        if (window) ::SetFocus(window);
        return S_OK;
    }
    IFACEMETHODIMP QueryFocus(HWND *out) override {
        if (!out) return E_POINTER;
        *out = GetFocus();
        return *out ? S_OK : HRESULT_FROM_WIN32(GetLastError());
    }
    IFACEMETHODIMP TranslateAccelerator(MSG *msg) override {
        // Explorer's own shortcut keys keep working while the preview has the keyboard
        return frame ? frame->TranslateAccelerator(msg) : S_FALSE;
    }

  private:
    static void registerClass() {
        WNDCLASSEXW cls = {};
        cls.cbSize = sizeof cls;
        if (GetClassInfoExW(self, PREVIEW_CLASS, &cls)) return;
        cls.style = CS_HREDRAW | CS_VREDRAW;
        cls.lpfnWndProc = Preview::proc;
        cls.hInstance = self;
        cls.hCursor = LoadCursor(nullptr, IDC_ARROW);
        cls.lpszClassName = PREVIEW_CLASS;
        RegisterClassExW(&cls);
    }

    void place() {
        SetWindowPos(window, nullptr, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, SWP_NOZORDER | SWP_NOACTIVATE);
    }

    int dpi() const {
        UINT d = window ? GetDpiForWindow(window) : 96;
        return d ? static_cast<int>(d) : 96;
    }
    int px(int at96) const { return MulDiv(at96, dpi(), 96); }

    void forget() {
        for (Drawn &d : drawn) DeleteObject(d.bitmap);
        drawn.clear();
    }

    /** Works out where each page goes for the window's width, and the scroll bar to match. */
    void layout() {
        RECT client;
        GetClientRect(window, &client);
        int width = client.right - client.left, height = client.bottom - client.top;
        int margin = px(12), gap = px(10);
        int pageWidth = width - 2 * margin;
        if (pageWidth < px(40)) pageWidth = px(40);
        forget();
        tops.assign(widths.size(), 0);
        sizesX.assign(widths.size(), 0);
        sizesY.assign(widths.size(), 0);
        int y = margin;
        for (size_t i = 0; i < widths.size(); i++) {
            sizesX[i] = pageWidth;
            sizesY[i] = static_cast<int>(pageWidth * heights[i] / widths[i] + 0.5);
            if (sizesY[i] < 1) sizesY[i] = 1;
            tops[i] = y;
            y += sizesY[i] + gap;
        }
        total = y - gap + margin;
        setScroll(scroll, height);
    }

    void setScroll(int to, int height) {
        int most = total - height;
        if (most < 0) most = 0;
        scroll = to < 0 ? 0 : to > most ? most : to;
        SCROLLINFO info = {};
        info.cbSize = sizeof info;
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMin = 0;
        info.nMax = total > 0 ? total - 1 : 0;
        info.nPage = static_cast<UINT>(height > 0 ? height : 0);
        info.nPos = scroll;
        SetScrollInfo(window, SB_VERT, &info, TRUE);
    }

    void scrollTo(int to) {
        RECT client;
        GetClientRect(window, &client);
        int before = scroll;
        setScroll(to, client.bottom - client.top);
        if (scroll != before) InvalidateRect(window, nullptr, FALSE);
    }

    /** Page `i` drawn at its laid-out size, from the ones kept or drawn now. */
    HBITMAP pageBitmap(int i) {
        for (Drawn &d : drawn) {
            if (d.page == i) {
                d.used = ++clock;
                return d.bitmap;
            }
        }
        void *bits = nullptr;
        HBITMAP bitmap = makeBitmap(sizesX[i], sizesY[i], &bits);
        if (!bitmap) return nullptr;
        AcquireSRWLockExclusive(&pdfiumLock);
        bool ok = firstpage::drawPage(pdfium, doc, i, sizesX[i], sizesY[i], bits, firstpage::DRAW_ANNOTATIONS | firstpage::LCD_TEXT);
        ReleaseSRWLockExclusive(&pdfiumLock);
        if (!ok) {
            DeleteObject(bitmap);
            return nullptr;
        }
        // keep the dozen most recently seen; drop the oldest
        if (drawn.size() >= 12) {
            size_t oldest = 0;
            for (size_t k = 1; k < drawn.size(); k++) if (drawn[k].used < drawn[oldest].used) oldest = k;
            DeleteObject(drawn[oldest].bitmap);
            drawn.erase(drawn.begin() + static_cast<long>(oldest));
        }
        drawn.push_back({ i, bitmap, ++clock });
        return bitmap;
    }

    void paint(HDC target) {
        RECT client;
        GetClientRect(window, &client);
        int width = client.right, height = client.bottom;
        if (width <= 0 || height <= 0) return;
        // drawn off-screen first, so scrolling doesn't flicker
        HDC dc = CreateCompatibleDC(target);
        HBITMAP canvas = CreateCompatibleBitmap(target, width, height);
        HGDIOBJ oldCanvas = SelectObject(dc, canvas);
        HBRUSH back = CreateSolidBrush(background);
        FillRect(dc, &client, back);
        DeleteObject(back);

        HDC pageDc = CreateCompatibleDC(target);
        HPEN edge = CreatePen(PS_SOLID, 1, RGB(200, 200, 200));
        HGDIOBJ oldPen = SelectObject(dc, edge);
        HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(NULL_BRUSH));
        for (size_t i = 0; i < tops.size(); i++) {
            int top = tops[i] - scroll;
            if (top >= height) break;
            if (top + sizesY[i] <= 0) continue;
            int left = (width - sizesX[i]) / 2;
            HBITMAP page = pageBitmap(static_cast<int>(i));
            if (page) {
                HGDIOBJ old = SelectObject(pageDc, page);
                BitBlt(dc, left, top, sizesX[i], sizesY[i], pageDc, 0, 0, SRCCOPY);
                SelectObject(pageDc, old);
            } else {
                RECT paper = { left, top, left + sizesX[i], top + sizesY[i] };
                FillRect(dc, &paper, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
            }
            Rectangle(dc, left - 1, top - 1, left + sizesX[i] + 1, top + sizesY[i] + 1);
        }
        SelectObject(dc, oldBrush);
        SelectObject(dc, oldPen);
        DeleteObject(edge);
        DeleteDC(pageDc);

        BitBlt(target, 0, 0, width, height, dc, 0, 0, SRCCOPY);
        SelectObject(dc, oldCanvas);
        DeleteObject(canvas);
        DeleteDC(dc);
    }

    LRESULT handle(UINT message, WPARAM wParam, LPARAM lParam) {
        RECT client;
        GetClientRect(window, &client);
        int height = client.bottom - client.top;
        int line = px(48);
        switch (message) {
        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC dc = BeginPaint(window, &ps);
            paint(dc);
            EndPaint(window, &ps);
            return 0;
        }
        case WM_ERASEBKGND:
            return 1; // painted with everything else
        case WM_SIZE:
            layout();
            InvalidateRect(window, nullptr, FALSE);
            return 0;
        case WM_VSCROLL: {
            SCROLLINFO info = {};
            info.cbSize = sizeof info;
            info.fMask = SIF_TRACKPOS;
            GetScrollInfo(window, SB_VERT, &info);
            switch (LOWORD(wParam)) {
            case SB_LINEUP: scrollTo(scroll - line); break;
            case SB_LINEDOWN: scrollTo(scroll + line); break;
            case SB_PAGEUP: scrollTo(scroll - height * 9 / 10); break;
            case SB_PAGEDOWN: scrollTo(scroll + height * 9 / 10); break;
            case SB_THUMBTRACK:
            case SB_THUMBPOSITION: scrollTo(info.nTrackPos); break;
            case SB_TOP: scrollTo(0); break;
            case SB_BOTTOM: scrollTo(total); break;
            }
            return 0;
        }
        case WM_MOUSEWHEEL: {
            UINT lines = 3;
            SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
            int delta = GET_WHEEL_DELTA_WPARAM(wParam);
            int step = lines == WHEEL_PAGESCROLL ? height : static_cast<int>(lines) * line / 3 * 2;
            scrollTo(scroll - MulDiv(delta, step, WHEEL_DELTA));
            return 0;
        }
        case WM_KEYDOWN:
            switch (wParam) {
            case VK_UP: scrollTo(scroll - line); return 0;
            case VK_DOWN: scrollTo(scroll + line); return 0;
            case VK_PRIOR: scrollTo(scroll - height * 9 / 10); return 0;
            case VK_NEXT:
            case VK_SPACE: scrollTo(scroll + height * 9 / 10); return 0;
            case VK_HOME: scrollTo(0); return 0;
            case VK_END: scrollTo(total); return 0;
            }
            break;
        case WM_LBUTTONDOWN:
            ::SetFocus(window);
            return 0;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    static LRESULT CALLBACK proc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
        if (message == WM_NCCREATE) {
            auto *made = reinterpret_cast<Preview *>(reinterpret_cast<CREATESTRUCTW *>(lParam)->lpCreateParams);
            made->window = hwnd;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(made));
        }
        auto *preview = reinterpret_cast<Preview *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (preview && preview->window == hwnd) return preview->handle(message, wParam, lParam);
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
};

// --- making them -----------------------------------------------------------------------------

template <typename T> class Factory final : public IClassFactory {
  public:
    IFACEMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *out = static_cast<IClassFactory *>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return 2; }
    IFACEMETHODIMP_(ULONG) Release() override { return 1; }
    IFACEMETHODIMP CreateInstance(IUnknown *outer, REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        T *made = new (std::nothrow) T();
        if (!made) return E_OUTOFMEMORY;
        HRESULT hr = made->QueryInterface(riid, out);
        made->Release();
        return hr;
    }
    IFACEMETHODIMP LockServer(BOOL lock) override {
        if (lock) InterlockedIncrement(&locks);
        else InterlockedDecrement(&locks);
        return S_OK;
    }
};

static Factory<Thumbnails> thumbnailFactory;
static Factory<Preview> previewFactory;

// --- what Windows calls ---------------------------------------------------------------------

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        self = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void **out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (clsid == INKLEAF_THUMBNAILS) return thumbnailFactory.QueryInterface(riid, out);
    if (clsid == INKLEAF_PREVIEW) return previewFactory.QueryInterface(riid, out);
    return CLASS_E_CLASSNOTAVAILABLE;
}

STDAPI DllCanUnloadNow() {
    return objects == 0 && locks == 0 ? S_OK : S_FALSE;
}
