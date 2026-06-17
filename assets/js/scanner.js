let qrReader;
let loginAttempted = false;

/* ── Config backend (aligné sur portal.js) ── */
const CFG = {
  backendUrl: "https://wifizone.fite-ne.com", /* ← adapter selon votre backend */
  /* Mode strict : si la vérification du profil est injoignable (réseau), on bloque
     au lieu de laisser passer. Garder cohérent avec portal.js / verify_login.php. */
  strictProfileCheck: true
};

function apiPost(path, data, timeoutMs) {
  return fetch(CFG.backendUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || 4000) : undefined
  }).then((r) => r.json());
}

/* Vérifie côté backend que le code scanné est autorisé (profil MikroTik valide).
   15 s car l'API RouterOS est lente. */
function verifyProfile(u) {
  return apiPost("/api/verify_login.php", { username: u, package_id: 0 }, 15000);
}

/* Extrait l'identifiant/voucher du QR : soit un paramètre d'URL (username/user/voucher),
   soit le texte brut si le QR n'est pas une URL. */
function extractUsername(text) {
  try {
    const params = new URL(text).searchParams;
    return (params.get("username") || params.get("user") || params.get("u") || params.get("voucher") || "").trim();
  } catch (_) {
    return (text || "").trim();
  }
}

function setScannerHint(message) {
  const hintEl = document.getElementById("scannerHint");
  if (!hintEl) return;
  hintEl.textContent = message;
}

function resolveHotspotName() {
  const params = new URLSearchParams(window.location.search);
  const host = (params.get("host") || "").trim();
  return host || location.hostname || "hotspot";
}

function renderHotspotName() {
  const el = document.getElementById("hotspotName");
  if (!el) return;
  el.textContent = resolveHotspotName();
}

async function requestCameraPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScannerHint("Votre navigateur ne prend pas en charge l'accès à la caméra.");
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    stream.getTracks().forEach((track) => track.stop());
    setScannerHint("L'accès à la caméra est autorisé.");
    return true;
  } catch (_) {
    setScannerHint("L'accès à la caméra a été refusé. Autorisez l'accès à la caméra dans le navigateur/WebView, puis réessayez.");
    return false;
  }
}

function initCameraAccessButton() {
  const btn = document.getElementById("cameraAccessBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const granted = await requestCameraPermission();
    if (!granted) return;
    loginAttempted = false;
    startScanner();
  });
}

function tryOpenExternalBrowser() {
  const currentUrl = window.location.href;
  const isAndroid = /Android/i.test(navigator.userAgent);

  if (isAndroid) {
    const noProto = currentUrl.replace(/^https?:\/\//, "");
    const intentUrl = `intent://${noProto}#Intent;scheme=https;package=com.android.chrome;end`;
    window.location.href = intentUrl;
    return;
  }

  window.open(currentUrl, "_blank", "noopener,noreferrer");
}

function initOpenBrowserButton() {
  const btn = document.getElementById("openBrowserBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    tryOpenExternalBrowser();
  });
}

function resolveBackLoginUrl() {
  const params = new URLSearchParams(window.location.search);
  const host = (params.get("host") || "").trim();
  const proto = ((params.get("proto") || "http").trim() || "http").replace(":", "");

  if (host) {
    return `${proto}://${host}/login`;
  }

  return "";
}

function initBackLoginButton() {
  const btn = document.getElementById("backLoginBtn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const backUrl = resolveBackLoginUrl();
    if (backUrl) {
      window.location.href = backUrl;
      return;
    }

    if (document.referrer) {
      window.location.href = document.referrer;
      return;
    }

    window.history.back();
  });
}

function startScanner() {
  if (loginAttempted) return;
  setScannerHint("Démarrage de la caméra...");

  qrReader = new Html5Qrcode("qr-reader");

  qrReader
    .start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: undefined,
        aspectRatio: 1
      },
      (decodedText) => {
        loginAttempted = true;
        qrReader.stop().then(() => {
          setScannerHint("QR code détecté, vérification…");
          verifyAndRedirect(decodedText);
        });
      }
    )
    .catch(() => {
      loginAttempted = false;
      setScannerHint("La caméra n'a pas pu être ouverte. Cliquez sur « Accéder à la caméra » puis autorisez l'accès.");
    });
}

/* Contrôle backend du code scanné avant redirection (calque sur portal.js).
   Tout refus → on bloque et on relance le scan ; sans identifiant exploitable,
   on redirige directement (le QR porte sa propre URL de login). */
function verifyAndRedirect(decodedText) {
  const username = extractUsername(decodedText);

  function redirect() {
    if (window.SpaceStars) {
      window.SpaceStars.stop();
    }
    setScannerHint("Connexion autorisée, redirection…");
    setTimeout(() => {
      window.location.href = decodedText;
    }, 1500);
  }

  function refuse(message) {
    loginAttempted = false;
    setScannerHint(message);
    /* Laisse l'utilisateur scanner un autre code. */
    setTimeout(startScanner, 2500);
  }

  if (!username) {
    redirect();
    return;
  }

  verifyProfile(username).then((v) => {
    if (v && v.ok === false) {
      refuse(v.error || "Connexion refusée. Vérifiez votre code.");
      return;
    }
    redirect();
  }).catch((err) => {
    console.error("verify_login.php injoignable :", err);
    if (CFG.strictProfileCheck) {
      refuse("Vérification impossible (réseau). Réessayez.");
    } else {
      redirect();
    }
  });
}
