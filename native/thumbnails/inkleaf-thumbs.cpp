// SPDX-License-Identifier: GPL-3.0-or-later
// Inkleaf's PDF thumbnails for File Explorer on Windows.
//
// Explorer asks the app that opens a file type for its pictures of those
// files. Once Inkleaf opens PDFs, this is what Explorer asks: it draws the
// first page of each PDF, with PDFium (the PDF engine in Chrome), which sits
// next to this DLL as pdfium.dll.
//
// Explorer runs thumbnail makers in a separate process and may call them
// from several threads, so PDFium, which isn't thread-safe, is used by one
// call at a time. A PDF that can't be read (damaged, or locked with a
// password) simply gets no thumbnail, and Explorer shows Inkleaf's icon.
//
// Registered by the installer (build/installer.nsh) and by the Microsoft
// Store package (build/appx-manifest.js) under INKLEAF_THUMBNAILS below.

#include <windows.h>
#include <new>
#include <shlwapi.h>
#include <propsys.h>
#include <thumbcache.h>

#include "first-page.h"

// {1EBEB7F8-27A7-4B2A-A890-88C35591D436}
static const CLSID INKLEAF_THUMBNAILS = { 0x1ebeb7f8, 0x27a7, 0x4b2a, { 0xa8, 0x90, 0x88, 0xc3, 0x55, 0x91, 0xd4, 0x36 } };

// IThumbnailProvider's own id (also the "thumbnail" key under a file type's ShellEx);
// spelled out because not every set of Windows headers ships it in a library
static const IID THUMBNAIL_PROVIDER = { 0xe357fccd, 0xa995, 0x4576, { 0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96 } };

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

/** The first page of `data`, `size` pixels on its longer side, as a bitmap for Explorer. */
static HRESULT drawFirstPage(const BYTE *data, DWORD length, UINT size, HBITMAP *out) {
    // PDFium isn't thread-safe, and Explorer may ask from several threads
    AcquireSRWLockExclusive(&pdfiumLock);
    HBITMAP dib = nullptr;
    bool drawn = loadPdfium() && firstpage::draw(pdfium, data, length, size, [&dib](int width, int height) -> void * {
        // a top-down 32-bit bitmap that PDFium draws straight into
        BITMAPINFO info = {};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        void *bits = nullptr;
        dib = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
        return dib ? bits : nullptr;
    });
    ReleaseSRWLockExclusive(&pdfiumLock);
    if (!drawn) {
        if (dib) DeleteObject(dib);
        return E_FAIL;
    }
    *out = dib;
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

    // IInitializeWithStream: the PDF, read whole (PDFium needs to jump about in it)
    IFACEMETHODIMP Initialize(IStream *stream, DWORD) override {
        if (!stream) return E_INVALIDARG;
        if (data) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
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
        data = buffer;
        length = got;
        return S_OK;
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

class Factory final : public IClassFactory {
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
        Thumbnails *made = new (std::nothrow) Thumbnails();
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

static Factory factory;

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
    if (clsid != INKLEAF_THUMBNAILS) return CLASS_E_CLASSNOTAVAILABLE;
    return factory.QueryInterface(riid, out);
}

STDAPI DllCanUnloadNow() {
    return objects == 0 && locks == 0 ? S_OK : S_FALSE;
}
