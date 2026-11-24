package com.yansima.remotedesktop;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final int PERMISSION_REQUEST_CODE = 1001;
    private static final int SCREEN_CAPTURE_REQUEST_CODE = 1002;

    private MediaProjectionManager projectionManager;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private volatile String latestFrameB64 = null;
    private int captureW = 720;
    private int captureH = 1280;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        String[] perms = new String[]{
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.MODIFY_AUDIO_SETTINGS,
            Manifest.permission.CAMERA
        };
        List<String> needed = new ArrayList<>();
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needed.add(p);
            }
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void setOrientation(final String mode) {
                    runOnUiThread(() -> {
                        if ("landscape".equals(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        } else if ("portrait".equals(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                        } else {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                        }
                    });
                }

                @JavascriptInterface
                public void setFullscreen(final boolean enabled) {
                    runOnUiThread(() -> {
                        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
                            getWindow(),
                            getWindow().getDecorView()
                        );
                        if (controller == null) return;
                        if (enabled) {
                            controller.setSystemBarsBehavior(
                                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                            );
                            controller.hide(WindowInsetsCompat.Type.systemBars());
                        } else {
                            controller.show(WindowInsetsCompat.Type.systemBars());
                        }
                    });
                }

                @JavascriptInterface
                public void startScreenCapture() {
                    runOnUiThread(() -> {
                        if (mediaProjection != null) {
                            notifyScreenCaptureReady(true);
                            return;
                        }
                        if (projectionManager != null) {
                            startActivityForResult(
                                projectionManager.createScreenCaptureIntent(),
                                SCREEN_CAPTURE_REQUEST_CODE
                            );
                        } else {
                            notifyScreenCaptureReady(false);
                        }
                    });
                }

                @JavascriptInterface
                public void stopScreenCapture() {
                    runOnUiThread(() -> releaseScreenCapture());
                }

                @JavascriptInterface
                public String getLatestFrame() {
                    return latestFrameB64;
                }
            }, "AndroidBridge");

            this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                }
            });
        }
    }

    private void notifyScreenCaptureReady(boolean ok) {
        if (this.bridge != null && this.bridge.getWebView() != null) {
            final String js = "window.__onAndroidCaptureReady && window.__onAndroidCaptureReady(" + ok + ");";
            runOnUiThread(() -> this.bridge.getWebView().evaluateJavascript(js, null));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SCREEN_CAPTURE_REQUEST_CODE) {
            if (resultCode == Activity.RESULT_OK && data != null && projectionManager != null) {
                startProjection(resultCode, data);
                notifyScreenCaptureReady(true);
            } else {
                notifyScreenCaptureReady(false);
            }
        }
    }

    private void startProjection(int resultCode, Intent data) {
        releaseScreenCapture();
        mediaProjection = projectionManager.getMediaProjection(resultCode, data);
        if (mediaProjection == null) return;

        DisplayMetrics metrics = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
        int w = metrics.widthPixels;
        int h = metrics.heightPixels;
        int maxDim = 960;
        if (w > maxDim || h > maxDim) {
            float scale = Math.min((float) maxDim / w, (float) maxDim / h);
            captureW = Math.max(2, Math.round(w * scale) & ~1);
            captureH = Math.max(2, Math.round(h * scale) & ~1);
        } else {
            captureW = w;
            captureH = h;
        }

        captureThread = new HandlerThread("YansimaScreenCap");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());

        imageReader = ImageReader.newInstance(captureW, captureH, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(reader -> {
            Image image = null;
            try {
                image = reader.acquireLatestImage();
                if (image == null) return;
                Image.Plane[] planes = image.getPlanes();
                ByteBuffer buffer = planes[0].getBuffer();
                int pixelStride = planes[0].getPixelStride();
                int rowStride = planes[0].getRowStride();
                int rowPadding = rowStride - pixelStride * captureW;

                Bitmap bmp = Bitmap.createBitmap(
                    captureW + rowPadding / pixelStride,
                    captureH,
                    Bitmap.Config.ARGB_8888
                );
                bmp.copyPixelsFromBuffer(buffer);
                Bitmap cropped = Bitmap.createBitmap(bmp, 0, 0, captureW, captureH);
                bmp.recycle();

                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                cropped.compress(Bitmap.CompressFormat.JPEG, 70, baos);
                cropped.recycle();
                latestFrameB64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception ignored) {
            } finally {
                if (image != null) image.close();
            }
        }, captureHandler);

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "YansimaScreen",
            captureW,
            captureH,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
    }

    private void releaseScreenCapture() {
        latestFrameB64 = null;
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Exception ignored) {}
            virtualDisplay = null;
        }
        if (imageReader != null) {
            try { imageReader.close(); } catch (Exception ignored) {}
            imageReader = null;
        }
        if (mediaProjection != null) {
            try { mediaProjection.stop(); } catch (Exception ignored) {}
            mediaProjection = null;
        }
        if (captureThread != null) {
            try { captureThread.quitSafely(); } catch (Exception ignored) {}
            captureThread = null;
        }
    }

    @Override
    public void onDestroy() {
        releaseScreenCapture();
        super.onDestroy();
    }
}
