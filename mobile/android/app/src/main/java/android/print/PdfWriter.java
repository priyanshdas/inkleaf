// SPDX-License-Identifier: GPL-3.0-or-later
package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.File;

/**
 * Runs a WebView's print adapter straight into a PDF file, without showing the
 * print dialog. It lives in the android.print package because the adapter's
 * callback classes can only be created from there; this is the usual way apps
 * turn a web page into a PDF on Android.
 */
public final class PdfWriter {
    public interface Done {
        void onDone(String error);
    }

    private PdfWriter() {}

    public static void write(final PrintDocumentAdapter adapter, final PrintAttributes attributes, final File out, final Done done) {
        adapter.onStart();
        adapter.onLayout(null, attributes, null, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                try {
                    final ParcelFileDescriptor fd = ParcelFileDescriptor.open(out,
                        ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE);
                    adapter.onWrite(new PageRange[] { PageRange.ALL_PAGES }, fd, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                        @Override
                        public void onWriteFinished(PageRange[] pages) {
                            close(fd);
                            adapter.onFinish();
                            done.onDone(null);
                        }

                        @Override
                        public void onWriteFailed(CharSequence error) {
                            close(fd);
                            adapter.onFinish();
                            done.onDone(error == null ? "write failed" : error.toString());
                        }

                        @Override
                        public void onWriteCancelled() {
                            close(fd);
                            adapter.onFinish();
                            done.onDone("cancelled");
                        }
                    });
                } catch (Exception e) {
                    done.onDone(e.getMessage());
                }
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                done.onDone(error == null ? "layout failed" : error.toString());
            }
        }, null);
    }

    private static void close(ParcelFileDescriptor fd) {
        try {
            fd.close();
        } catch (Exception ignored) {
            // nothing left to do
        }
    }
}
