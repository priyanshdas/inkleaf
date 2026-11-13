// SPDX-License-Identifier: GPL-3.0-or-later
// For trying on Windows: checks inkleaf-thumbs.dll the way File Explorer uses it: create the
// thumbnail maker through COM's entry point, hand it a PDF as a stream, ask
// for a picture, and save the picture as a .bmp to look at.
//   test-thumbs.exe <dll> <pdf> <size> <out.bmp>
#include <windows.h>
#include <shlwapi.h>
#include <propsys.h>
#include <thumbcache.h>
#include <cstdio>

static const CLSID INKLEAF_THUMBNAILS = { 0x1ebeb7f8, 0x27a7, 0x4b2a, { 0xa8, 0x90, 0x88, 0xc3, 0x55, 0x91, 0xd4, 0x36 } };
static const IID THUMBNAIL_PROVIDER = { 0xe357fccd, 0xa995, 0x4576, { 0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96 } };

int wmain(int argc, wchar_t **argv) {
    if (argc < 5) return 2;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    HMODULE dll = LoadLibraryW(argv[1]);
    if (!dll) { printf("FAIL load dll %lu\n", GetLastError()); return 1; }
    auto get = reinterpret_cast<HRESULT(WINAPI *)(REFCLSID, REFIID, void **)>(reinterpret_cast<void *>(GetProcAddress(dll, "DllGetClassObject")));
    IClassFactory *factory = nullptr;
    if (!get || FAILED(get(INKLEAF_THUMBNAILS, IID_IClassFactory, reinterpret_cast<void **>(&factory)))) { printf("FAIL factory\n"); return 1; }
    IInitializeWithStream *init = nullptr;
    if (FAILED(factory->CreateInstance(nullptr, IID_IInitializeWithStream, reinterpret_cast<void **>(&init)))) { printf("FAIL create\n"); return 1; }

    HANDLE file = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    DWORD size = GetFileSize(file, nullptr), got = 0;
    BYTE *bytes = new BYTE[size];
    ReadFile(file, bytes, size, &got, nullptr);
    CloseHandle(file);
    IStream *stream = SHCreateMemStream(bytes, got);
    HRESULT hr = init->Initialize(stream, STGM_READ);
    if (FAILED(hr)) { printf("NOPICTURE initialize %08lx\n", hr); return 0; }

    IThumbnailProvider *thumbs = nullptr;
    if (FAILED(init->QueryInterface(THUMBNAIL_PROVIDER, reinterpret_cast<void **>(&thumbs)))) { printf("FAIL query\n"); return 1; }
    HBITMAP bitmap = nullptr;
    WTS_ALPHATYPE alpha;
    hr = thumbs->GetThumbnail(_wtoi(argv[3]), &bitmap, &alpha);
    if (FAILED(hr) || !bitmap) { printf("NOPICTURE %08lx\n", hr); return 0; }

    BITMAP info = {};
    GetObject(bitmap, sizeof info, &info);
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = info.bmWidth;
    bi.bmiHeader.biHeight = info.bmHeight;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    DWORD imageSize = info.bmWidth * 4 * info.bmHeight;
    BYTE *pixels = new BYTE[imageSize];
    HDC dc = GetDC(nullptr);
    GetDIBits(dc, bitmap, 0, info.bmHeight, pixels, &bi, DIB_RGB_COLORS);
    ReleaseDC(nullptr, dc);
    BITMAPFILEHEADER fh = {};
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof fh + sizeof(BITMAPINFOHEADER);
    fh.bfSize = fh.bfOffBits + imageSize;
    FILE *out = _wfopen(argv[4], L"wb");
    fwrite(&fh, sizeof fh, 1, out);
    fwrite(&bi.bmiHeader, sizeof(BITMAPINFOHEADER), 1, out);
    fwrite(pixels, imageSize, 1, out);
    fclose(out);
    printf("OK %ldx%ld alpha=%d\n", info.bmWidth, info.bmHeight, (int)alpha);
    DeleteObject(bitmap);
    thumbs->Release();
    init->Release();
    stream->Release();
    factory->Release();
    return 0;
}
