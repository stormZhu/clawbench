package com.clawbench.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import static org.junit.Assert.assertEquals;

/**
 * Behavioural tests for the preferences {@link TailcatService} restores from after a
 * process kill, using real {@link SharedPreferences} via Robolectric.
 *
 * <p>These exist because the two ports in play are trivially confusable and were in
 * fact confused once: the restart path read {@code tailcat_local_port} (the loopback
 * port the OS handed us) and passed it as the remote ClawBench port to dial. The two
 * are different numbers owned by different ends of the tunnel, and a Tailcat address
 * (ConnBlob) carries no port at all, so nothing else can recover it.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class TailcatServicePrefsTest {

    private Context context() {
        return RuntimeEnvironment.getApplication();
    }

    private SharedPreferences prefs() {
        return context().getSharedPreferences(
                TailcatService.PREFS_NAME, Context.MODE_PRIVATE);
    }

    @Test
    public void restoredServerPort_readsTheRemotePortKeyNotTheLocalOne() {
        // Both keys populated, with different values — the only way to tell whether
        // the right one is read.
        prefs().edit().clear()
                .putInt(TailcatService.KEY_TAILCAT_SERVER_PORT, 20000)
                .putInt(TailcatService.KEY_TAILCAT_LOCAL_PORT, 54321)
                .commit();

        assertEquals("must restore the remote ClawBench port, not the loopback one",
                20000, TailcatService.restoredServerPort(context()));
    }

    @Test
    public void restoredServerPort_isZeroWhenOnlyTheLocalPortWasEverPersisted() {
        // A pre-fix install has a local port but no remote port. Reporting the local
        // one would silently dial the wrong port; reporting 0 makes the start fail
        // loudly instead, and the login page asks the user again.
        prefs().edit().clear()
                .putInt(TailcatService.KEY_TAILCAT_LOCAL_PORT, 54321)
                .commit();

        assertEquals(0, TailcatService.restoredServerPort(context()));
    }

    @Test
    public void restoredServerPort_isZeroWhenNothingWasPersisted() {
        prefs().edit().clear().commit();
        assertEquals(0, TailcatService.restoredServerPort(context()));
    }

    @Test
    public void restoredAddress_roundTripsAndDefaultsToEmpty() {
        prefs().edit().clear().commit();
        assertEquals("", TailcatService.restoredAddress(context()));

        prefs().edit()
                .clear()
                .putString(TailcatService.KEY_TAILCAT_ADDRESS, "tcAwoRGB8mLTQ7QklQV15lbHN6")
                .commit();
        assertEquals("tcAwoRGB8mLTQ7QklQV15lbHN6",
                TailcatService.restoredAddress(context()));
    }
}
