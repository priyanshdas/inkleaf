// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PdfWriter;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * The phone app's own native helpers, for things no stock Capacitor plugin does:
 * "Save a copy to…" with Android's file dialog, printing, turning HTML (and web
 * pages) into PDFs, and PDFs handed to Inkleaf by other apps.
 */
@CapacitorPlugin(name = "InkleafFiles")
public class InkleafFilesPlugin extends Plugin {

    /** Files from "Open with" and "Share", waiting for the editor to take them. */
    private static final List<Uri> incoming = new ArrayList<>();
    private static InkleafFilesPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Called by MainActivity for the intent that started the app and any that arrive later. */
    static void handleIntent(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        synchronized (incoming) {
            if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
                incoming.add(intent.getData());
            } else if (Intent.ACTION_SEND.equals(action)) {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) incoming.add(uri);
            } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (uris != null) incoming.addAll(uris);
            } else {
                return;
            }
        }
        if (instance != null) instance.notifyListeners("incoming", new JSObject());
    }

    /**
     * Whether an app store installed Inkleaf. Store copies are kept up to date by the store, so the
     * app's own "new version" check (for the APK from GitHub) stays quiet for them.
     */
    @PluginMethod
    public void installSource(PluginCall call) {
        String installer = null;
        try {
            Context context = getContext();
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                installer = context.getPackageManager().getInstallSourceInfo(context.getPackageName()).getInstallingPackageName();
            } else {
                installer = context.getPackageManager().getInstallerPackageName(context.getPackageName());
            }
        } catch (Exception ignored) {
            // unknown: treat it as sideloaded
        }
        boolean store = installer != null && (installer.equals("com.android.vending") || installer.equals("org.fdroid.fdroid")
            || installer.startsWith("com.amazon") || installer.equals("com.sec.android.app.samsungapps") || installer.equals("com.huawei.appmarket"));
        JSObject result = new JSObject();
        result.put("store", store);
        call.resolve(result);
    }

    @PluginMethod
    public void takeIncoming(PluginCall call) {
        List<Uri> uris;
        synchronized (incoming) {
            uris = new ArrayList<>(incoming);
            incoming.clear();
        }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject file = new JSObject();
                file.put("name", displayName(uri));
                file.put("data", Base64.encodeToString(readAll(uri), Base64.NO_WRAP));
                files.put(file);
            } catch (Exception e) {
                // a file we couldn't read (permission revoked, deleted): skip it
            }
        }
        JSObject result = new JSObject();
        result.put("files", files);
        call.resolve(result);
    }

    // --- Save a copy to… ---------------------------------------------------------------------

    @PluginMethod
    public void saveAs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/pdf"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "Document.pdf"));
        startActivityForResult(call, intent, "savedAs");
    }

    @ActivityCallback
    private void savedAs(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            JSObject done = new JSObject();
            done.put("uri", uri.toString());
            call.resolve(done);
        } catch (Exception e) {
            call.reject("Couldn’t save the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveMany(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "savedMany");
    }

    @ActivityCallback
    private void savedMany(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            Uri folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            JSArray files = call.getArray("files", new JSArray());
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                Uri created = DocumentsContract.createDocument(getContext().getContentResolver(), folder, f.optString("mime", "application/octet-stream"), f.optString("name", "file"));
                if (created == null) throw new Exception("couldn’t create " + f.optString("name"));
                try (OutputStream out = getContext().getContentResolver().openOutputStream(created, "wt")) {
                    out.write(Base64.decode(f.optString("data", ""), Base64.DEFAULT));
                }
            }
            JSObject done = new JSObject();
            done.put("folder", tree.toString());
            call.resolve(done);
        } catch (Exception e) {
            call.reject("Couldn’t save the files: " + e.getMessage());
        }
    }

    // --- printing -------------------------------------------------------------------------------

    @PluginMethod
    public void print(PluginCall call) {
        final byte[] pdf = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        final String name = call.getString("name", "Document.pdf");
        getActivity().runOnUiThread(() -> {
            PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            manager.print(name, new PrintDocumentAdapter() {
                @Override
                public void onLayout(PrintAttributes old, PrintAttributes now, CancellationSignal cancel, LayoutResultCallback callback, Bundle extras) {
                    if (cancel.isCanceled()) {
                        callback.onLayoutCancelled();
                        return;
                    }
                    callback.onLayoutFinished(new PrintDocumentInfo.Builder(name)
                        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true);
                }

                @Override
                public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancel, WriteResultCallback callback) {
                    try (OutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                        out.write(pdf);
                        callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
                    } catch (Exception e) {
                        callback.onWriteFailed(e.getMessage());
                    }
                }
            }, null);
            call.resolve();
        });
    }

    // --- HTML and web pages to PDF ------------------------------------------------------------------

    @PluginMethod
    public void htmlToPdf(PluginCall call) {
        render(call, call.getString("html", ""), null);
    }

    @PluginMethod
    public void urlToPdf(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.matches("(?i)^[a-z]+://.*")) url = "https://" + url;
        if (!url.matches("(?i)^https?://.*")) {
            call.reject("Only web addresses (http or https) can be printed.");
            return;
        }
        render(call, null, url);
    }

    /** Loads the HTML (or address) in an off-screen web view and prints it to a PDF file. */
    private void render(final PluginCall call, final String html, final String url) {
        final double width = call.getDouble("width", 8.27);
        final double height = call.getDouble("height", 11.69);
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        final double margin = call.getDouble("margin", url != null ? 0.4 : 0.8);
        getActivity().runOnUiThread(() -> {
            final WebView view = new WebView(getContext());
            WebSettings settings = view.getSettings();
            // documents converted from files never run scripts; web pages need them to look right
            settings.setJavaScriptEnabled(url != null);
            settings.setAllowFileAccess(false);
            settings.setLoadsImagesAutomatically(true);
            final Handler timeout = new Handler(Looper.getMainLooper());
            final boolean[] finished = { false };
            view.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    // converted documents are self-contained: nothing is fetched from the internet
                    if (html != null && !request.getUrl().toString().startsWith("data:")) {
                        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                    }
                    return null;
                }

                @Override
                public void onPageFinished(WebView v, String loaded) {
                    if (finished[0]) return;
                    finished[0] = true;
                    timeout.removeCallbacksAndMessages(null);
                    // let fonts and pictures settle before printing
                    timeout.postDelayed(() -> printToFile(call, view, width, height, landscape, margin, url != null), url != null ? 1500 : 300);
                }
            });
            timeout.postDelayed(() -> {
                if (finished[0]) return;
                finished[0] = true;
                view.destroy();
                call.reject("The page took too long to load.");
            }, 45_000);
            if (html != null) view.loadDataWithBaseURL("https://inkleaf.invalid/", html, "text/html", "utf-8", null);
            else view.loadUrl(url);
        });
    }

    private void printToFile(PluginCall call, WebView view, double width, double height, boolean landscape, double margin, boolean webPage) {
        try {
            int mils = (int) Math.round(margin * 1000);
            PrintAttributes.MediaSize size = new PrintAttributes.MediaSize("inkleaf", "Inkleaf",
                (int) Math.round((landscape ? height : width) * 1000), (int) Math.round((landscape ? width : height) * 1000));
            PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(size)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                .setMinMargins(new PrintAttributes.Margins(mils, mils, mils, mils))
                .build();
            final File out = File.createTempFile("inkleaf-", ".pdf", getContext().getCacheDir());
            final String title = view.getTitle();
            PdfWriter.write(view.createPrintDocumentAdapter("Inkleaf"), attributes, out, (error) -> {
                view.destroy();
                if (error != null) {
                    out.delete();
                    call.reject("Couldn’t make the PDF: " + error);
                    return;
                }
                try {
                    JSObject done = new JSObject();
                    done.put("data", Base64.encodeToString(readFile(out), Base64.NO_WRAP));
                    if (webPage) done.put("title", title == null ? "" : title);
                    call.resolve(done);
                } catch (Exception e) {
                    call.reject("Couldn’t read the PDF: " + e.getMessage());
                } finally {
                    out.delete();
                }
            });
        } catch (Exception e) {
            view.destroy();
            call.reject("Couldn’t make the PDF: " + e.getMessage());
        }
    }

    // --- helpers ----------------------------------------------------------------------------------

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // fall back to the address
        }
        String last = uri.getLastPathSegment();
        return last == null ? "Document.pdf" : last.substring(last.lastIndexOf('/') + 1);
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            return drain(in);
        }
    }

    private static byte[] readFile(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            return drain(in);
        }
    }

    private static byte[] drain(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toByteArray();
    }
}
