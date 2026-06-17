(function() {
    
        /* ── Config MikroTik ── */
        var CFG = {
            backendUrl: 'https://wifizone.fite-ne.com',  /* ← adapter selon votre backend */
            mac: '$(mac)',
            ip: '$(ip)',
            hasChap: ('$(chap-id)' !== ''),
            errorMsg: '$(error)',
            isTrial: ('$(trial)' === 'yes'),
            /* Mode strict côté navigateur : si la vérification du profil est injoignable
               (réseau), on bloque au lieu de laisser passer. L'obligation de forfait et la
               règle des profils « bypass » (ex. admin) sont gérées côté backend.
               ⚠ Garder cohérent avec STRICT_PROFILE_CHECK dans admin/api/verify_login.php */
            strictProfileCheck: true
        };



        /* ══════════════════════════════════════════
           INIT
        ══════════════════════════════════════════ */
        window.addEventListener('DOMContentLoaded', function () {
            if (CFG.errorMsg && CFG.errorMsg.indexOf('$(') === -1) {
                showErr(mapError(CFG.errorMsg));
                wzGo(2); /* erreur de connexion → afficher l'étape Connexion (err-box visible) */
            }
            fetchConfig();
            fetchAds();
            fetchPackages();
            fetchBonus();

            var buy = document.getElementById('buy-online');
            if (buy) { buy.href = CFG.backendUrl + '/pay.php'; buy.style.display = ''; }
        });

        /* ══════════════════════════════════════════
           CONFIG & SETTINGS
        ══════════════════════════════════════════ */
        function fetchConfig() {
            apiGet('/api/settings.php').then(function (d) {
                if (d.hs_name) document.getElementById('hs-name').textContent = d.hs_name;
                if (d.welcome_msg) document.getElementById('hs-sub').textContent = d.welcome_msg;
                if (d.logo_url) {
                    var w = document.getElementById('hs-logo-wrap');
                    w.innerHTML = '<img src="' + escAttr(d.logo_url) + '" alt="logo"/>';
                }
                if (d.payment_info) {
                    var pi = document.getElementById('pay-info');
                    pi.textContent = d.payment_info;
                    pi.style.display = '';
                }
                if (d.support_phone) document.getElementById('contact-phone').textContent = d.support_phone;
                if (d.support_whatsapp) document.getElementById('contact-wa').textContent = d.support_whatsapp;
                if (d.support_email) document.getElementById('contact-email').textContent = d.support_email;
                if (d.support_address) document.getElementById('contact-addr').textContent = d.support_address;
            }).catch(function () { });
        }

        /* state : retire le doublon adCloseTimer */
        var state = {
            pkgs: [], ads: [], adIdx: 0, adRaf: null, adStart: null,
            selPkg: null, bonuses: [], mode: 'v', dark: false,
            currentAdId: null
        };

        /* ══════════════════════════════════════════
           ADS
        ══════════════════════════════════════════ */
        function fetchAds() {
            apiGet('/api/ads.php').then(function (list) {
                state.ads = (Array.isArray(list) ? list : []).filter(Boolean);
                if (state.ads.length) {
                    buildAdDots();
                    var w = document.getElementById('ad-wrap');
                    w.classList.add('show');
                    w.setAttribute('aria-hidden', 'false');
                    rotateAd(0);
                } else {
                    closeAdPopup();
                }
            }).catch(function () { closeAdPopup(); });
        }

        function buildAdDots() {
            var dots = document.getElementById('ad-dots');
            if (state.ads.length < 2) { dots.innerHTML = ''; return; }
            var h = '';
            for (var i = 0; i < state.ads.length; i++) h += '<span></span>';
            dots.innerHTML = h;
        }

        function updateAdDots() {
            var dots = document.getElementById('ad-dots').children;
            for (var i = 0; i < dots.length; i++)
                dots[i].className = (i === state.adIdx ? 'on' : '');
        }

        function adImgFail(img) {
            var ph = document.createElement('div');
            ph.className = 'ad-placeholder';
            ph.textContent = '📢';
            if (img.parentNode) img.parentNode.replaceChild(ph, img);
        }

        function rotateAd(idx) {
            if (!state.ads.length) return;
            state.adIdx = idx;
            var ad = state.ads[idx];
            var inner = document.getElementById('ad-inner');
            var link = document.getElementById('ad-link');

            state.currentAdId = ad.id;
            inner.style.opacity = 0;

            /* Affiche le contenu + démarre minuteur/impression — appelé une seule fois, quand tout est prêt */
            function show() {
                var media = (ad.type === 'image' && ad.content)
                    ? '<img class="ad-img" src="' + escAttr(ad.content) + '" alt="' + escAttr(ad.title || '') + '" onerror="adImgFail(this)"/>'
                    : '<div class="ad-placeholder">📢</div>';
                inner.innerHTML =
                    media +
                    '<div>' +
                    '<div class="ad-title">' + esc(ad.title || '') + '</div>' +
                    (ad.subtitle ? '<div class="ad-sub">' + esc(ad.subtitle) + '</div>' : '') +
                    '</div>' +
                    (ad.link_url ? '<div class="ad-cta">En savoir plus →</div>' : '');
                inner.style.opacity = 1;

                link.href = ad.link_url || '#';
                link.onclick = function (e) {
                    if (!ad.link_url) { e.preventDefault(); return; }
                    trackAdClick();
                };

                apiPost('/api/ads.php?action=impression&id=' + ad.id + '&mac=' + encodeURIComponent(CFG.mac), {}).catch(function () { });
                updateAdDots();
                runAdTimer(Math.max((ad.duration_seconds || 8) * 1000, 1000));
            }

            /* Précharge l'image avant d'afficher (évite le rendu en deux temps) */
            if (ad.type === 'image' && ad.content) {
                var pre = new Image();
                var done = false;
                var go = function () { if (!done) { done = true; show(); } };
                pre.onload = go;
                pre.onerror = go;                 /* image cassée → on affiche quand même, adImgFail prend le relais */
                pre.src = ad.content;
                if (pre.complete) go();            /* déjà en cache */
                setTimeout(go, 1500);             /* garde-fou si le réseau traîne */
            } else {
                setTimeout(show, 60);
            }
        }

        function runAdTimer(dur) {
            var fill = document.getElementById('ad-bar-fill');
            var cd = document.getElementById('ad-countdown');
            var last = state.adIdx === state.ads.length - 1;

            if (state.adRaf) cancelAnimationFrame(state.adRaf);
            state.adStart = null;

            function step(ts) {
                if (!state.adStart) state.adStart = ts;
                var elapsed = ts - state.adStart;
                var pct = Math.min(elapsed / dur * 100, 100);
                fill.style.width = pct + '%';

                var remain = Math.max(0, Math.ceil((dur - elapsed) / 1000));
                cd.textContent = last ? 'Fermeture dans ' + remain + ' s'
                    : 'Suivant dans ' + remain + ' s';

                if (pct < 100) {
                    state.adRaf = requestAnimationFrame(step);
                } else {
                    if (last) closeAdPopup();
                    else rotateAd(state.adIdx + 1);
                }
            }
            state.adRaf = requestAnimationFrame(step);
        }

        function closeAdPopup() {
            if (state.adRaf) cancelAnimationFrame(state.adRaf);
            state.adRaf = null;
            var fill = document.getElementById('ad-bar-fill');
            if (fill) fill.style.width = '0%';
            var w = document.getElementById('ad-wrap');
            w.classList.remove('show');
            w.setAttribute('aria-hidden', 'true');
        }

        function trackAdClick() {
            if (state.currentAdId)
                apiPost('/api/ads.php?action=click&id=' + state.currentAdId, {}).catch(function () { });
        }

        /* ══════════════════════════════════════════
           PACKAGES
        ══════════════════════════════════════════ */
        function fetchPackages() {
            apiGet('/api/packages.php').then(function (list) {
                state.pkgs = Array.isArray(list) ? list : [];
                renderPackages();
            }).catch(function () {
                document.getElementById('pkg-grid').innerHTML = '';
                document.getElementById('offline-msg').style.display = '';
            });
        }

        function renderPackages() {
            var g = document.getElementById('pkg-grid');
            if (!state.pkgs.length) {
                g.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--sub);font-size:.8rem">Aucun forfait disponible.</div>';
                return;
            }
            g.innerHTML = state.pkgs.map(function (p) {
                return '<div class="pkg' + (p.is_popular ? ' pop' : '') + '" id="pkg-' + p.id + '" onclick="selPkg(' + p.id + ')">'
                    + '<div class="pkg-name">' + esc(p.name) + '</div>'
                    + '<div class="pkg-price">' + fmtPrice(p.price, p.currency) + '</div>'
                    + '<div class="pkg-per">/ ' + fmtDur(p.duration_hours) + '</div>'
                    + (p.speed_download_kb ? '<div class="pkg-row"><span class="ico-ok">✓</span>' + fmtSpd(p.speed_download_kb) + '</div>' : '')
                    + '<div class="pkg-row"><span class="ico-ok">✓</span>' + (p.data_limit_mb ? fmtData(p.data_limit_mb) : 'Illimité') + '</div>'
                    + (p.description ? '<div class="pkg-row" style="opacity:.7">' + esc(p.description) + '</div>' : '')
                    + '<button class="pkg-cta">Choisir →</button>'
                    + '</div>';
            }).join('');
        }

        function selPkg(id) {
            state.selPkg = null;
            for (var i = 0; i < state.pkgs.length; i++) {
                if (state.pkgs[i].id === id) { state.selPkg = state.pkgs[i]; break; }
            }
            if (!state.selPkg) return;
            state.pkgs.forEach(function (p) {
                var el = document.getElementById('pkg-' + p.id);
                if (el) el.className = el.className.replace(' sel', '') + (p.id === id ? ' sel' : '');
            });
            document.getElementById('sel-name').textContent = state.selPkg.name;
            document.getElementById('sel-price').textContent = fmtPrice(state.selPkg.price, state.selPkg.currency);
            document.getElementById('sel-info').style.display = 'flex';
            var buy = document.getElementById('buy-online');
            if (buy) buy.href = CFG.backendUrl + '/pay.php?pkg=' + id;
            /* Forfait choisi → passe directement à l'étape Connexion (avec récap + focus). */
            wzGo(2);
        }

        /* ══════════════════════════════════════════
           BONUS
        ══════════════════════════════════════════ */
        function fetchBonus() {
            if (!CFG.mac || CFG.mac.indexOf('$') !== -1) return;
            apiGet('/api/bonus.php?mac=' + encodeURIComponent(CFG.mac)).then(function (d) {
                state.bonuses = (d && d.bonuses) ? d.bonuses : [];
            }).catch(function () { });
        }

        function applyBonus(username, bonus) {
            return apiPost('/api/apply_bonus.php', { username: username, mac: CFG.mac, bonus_id: bonus.id, promo_code: '' });
        }

        /* ══════════════════════════════════════════
           LOGIN
        ══════════════════════════════════════════ */
        function doLogin(e, mode) {
            e.preventDefault();
            var u = mode === 'v' ? document.getElementById('uv').value.trim() : document.getElementById('ua').value.trim();
            var pw = mode === 'a' ? document.getElementById('pw').value : '';
            if (!u) { showErr(mode === 'v' ? 'Entrez votre code voucher.' : 'Entrez votre identifiant.'); return false; }
            if (mode === 'a' && !pw) { showErr('Entrez votre mot de passe.'); return false; }

            var btn = document.getElementById('btn-' + mode);
            btn.disabled = true;
            btn.innerHTML = '<div class="spin"></div> Vérification…';

            /* Contrôle backend : il décide selon le profil réel du code (vs forfait choisi),
               et autorise sans forfait les profils « bypass » (ex. admin). Tout refus → on bloque ;
               si aucun forfait n'était choisi, on guide l'utilisateur vers la liste des forfaits. */
            verifyProfile(u).then(function (v) {
                if (v && v.ok === false) {
                    resetLoginBtn(mode);
                    showErr(v.error || 'Connexion refusée.');
                    if (!state.selPkg) {
                        var grid = document.getElementById('pkg-grid');
                        if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    return;
                }
                proceedLogin(u, pw, mode);
            }).catch(function (err) {
                console.error('verify_login.php injoignable :', err);
                if (CFG.strictProfileCheck) {
                    resetLoginBtn(mode);
                    showErr('Vérification impossible (réseau). Réessayez.');
                } else {
                    proceedLogin(u, pw, mode);
                }
            });

            return false;
        }

        /* Vérifie côté backend que le profil MikroTik du code = celui du forfait sélectionné.
           Sans forfait sélectionné, rien à vérifier → on poursuit. */
        function verifyProfile(u) {
            /* Toujours vérifier côté backend, même sans forfait : un profil « bypass »
               (ex. admin) peut être autorisé sans forfait. 15 s car l'API RouterOS est lente. */
            return apiPost('/api/verify_login.php', {
                username: u,
                package_id: state.selPkg ? state.selPkg.id : 0
            }, 15000);
        }

        function proceedLogin(u, pw, mode) {
            var btn = document.getElementById('btn-' + mode);
            if (btn) btn.innerHTML = '<div class="spin"></div> Connexion…';

            trackSession(u);

            if (state.bonuses.length && state.bonuses[0].id) {
                applyBonus(u, state.bonuses[0]).then(function (res) {
                    if (res && res.applied === 'free_package' && res.new_voucher) {
                        showFreeVoucher(res, mode); return;
                    }
                    if (res && res.ok && res.applied && !res.info_only) {
                        showOk(res.detail || 'Bonus appliqué !');
                    }
                    finalLogin(u, pw, mode);
                }).catch(function () { finalLogin(u, pw, mode); });
            } else {
                finalLogin(u, pw, mode);
            }
        }

        function resetLoginBtn(mode) {
            var btn = document.getElementById('btn-' + mode);
            if (!btn) return;
            btn.disabled = false;
            btn.innerHTML = mode === 'a' ? '🔗 Se connecter' : '⚡ Se connecter';
        }

        function finalLogin(u, pw, mode) {
            var btn = document.getElementById('btn-' + (mode || state.mode));
            if (btn) btn.innerHTML = '<div class="spin"></div> Connexion…';
            if (CFG.hasChap && typeof _chapLogin === 'function') {
                _chapLogin(u, pw || u);
            } else {
                var form = (mode === 'a') ? document.loginA : document.loginV;
                form.username.value = u;
                form.password.value = pw || u;
                form.submit();
            }
        }

        function showFreeVoucher(res, mode) {
            var btn = document.getElementById('btn-' + (mode || state.mode));
            btn.disabled = false;
            btn.innerHTML = '⚡ Se connecter';
            if (document.getElementById('uv')) document.getElementById('uv').value = res.new_voucher;
            showOk('🎁 Forfait offert ! Code : <strong>' + esc(res.new_voucher) + '</strong>'
                + (res.package_name ? ' (' + esc(res.package_name) + ')' : '')
                + '<br><small>Cliquez "Se connecter" pour l\'utiliser.</small>');
        }

        function trackSession(username) {
            apiPost('/api/track.php', {
                mac: CFG.mac, ip: CFG.ip, username: username,
                package_id: state.selPkg ? state.selPkg.id : null,
                bonus: state.bonuses.length ? state.bonuses[0] : null
            }).catch(function () { });
        }

        /* ══════════════════════════════════════════
           UI HELPERS
        ══════════════════════════════════════════ */
        function switchTab(t) {
            state.mode = t;
            document.getElementById('tab-v').className = 'tab-btn ' + (t === 'v' ? 'on' : '');
            document.getElementById('tab-a').className = 'tab-btn ' + (t === 'a' ? 'on' : '');
            document.getElementById('fv').style.display = t === 'v' ? '' : 'none';
            document.getElementById('fa').style.display = t === 'a' ? '' : 'none';
            setTimeout(function () {
                var f = t === 'v' ? document.getElementById('uv') : document.getElementById('ua');
                if (f) f.focus();
            }, 50);
        }

        /* ── Wizard : Forfaits (1) → Connexion (2) ── */
        var wzStep = 1;
        function setStepper(n) {
            for (var i = 1; i <= 2; i++) {
                var s = document.getElementById('stp-' + i);
                if (s) s.className = 'stp' + (i < n ? ' done' : (i === n ? ' active' : ''));
            }
            var l = document.getElementById('wz-line');
            if (l) l.className = 'stp-line' + (n > 1 ? ' fill' : '');
        }
        function wzGo(n) {
            wzStep = n;
            document.getElementById('wz-1').style.display = (n === 1 ? '' : 'none');
            document.getElementById('wz-2').style.display = (n === 2 ? '' : 'none');
            setStepper(n);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (n === 2) {
                setTimeout(function () {
                    var f = state.mode === 'v' ? document.getElementById('uv') : document.getElementById('ua');
                    if (f) f.focus();
                }, 120);
            }
        }

        function togglePw() {
            var i = document.getElementById('pw');
            i.type = i.type === 'password' ? 'text' : 'password';
        }

        function toggleTheme() {
            state.dark = !state.dark;
            document.body.classList.toggle('dark', state.dark);
            document.getElementById('btn-theme').textContent = state.dark ? '☀️ Clair' : '🌙 Sombre';
        }

        function fmtV(el) {
            var v = el.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
            if (v.length > 9) v = v.slice(0, 9) + '-' + v.slice(9);
            el.value = v.slice(0, 20);
        }

        function showErr(m) {
            var b = document.getElementById('err-box');
            b.className = 'err-box';
            b.innerHTML = m;
            b.style.display = 'block';
        }

        function showOk(m) {
            var b = document.getElementById('err-box');
            b.className = 'err-box ok-box';
            b.innerHTML = m;
            b.style.display = 'block';
            setTimeout(function () { b.style.display = 'none'; b.className = 'err-box'; }, 4500);
        }

        function mapError(c) {
            var m = {
                'invalid username or password': 'Code invalide. Vérifiez votre voucher.',
                'user already logged in': 'Ce compte est déjà actif sur un autre appareil.',
                'user is disabled': 'Ce compte est désactivé.',
                'uptime limit reached': 'Temps de session épuisé.',
                'traffic limit reached': 'Volume de données épuisé.'
            };
            var lc = (c || '').toLowerCase();
            for (var k in m) { if (lc.indexOf(k) !== -1) return m[k]; }
            return 'Erreur : ' + c;
        }

        /* ══════════════════════════════════════════
           FORMAT HELPERS
        ══════════════════════════════════════════ */
        function fmtPrice(p, cur) {
            if (p === null || p === undefined) return '—';
            cur = cur || 'FCFA';
            try { return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(p) + ' ' + cur; }
            catch (e) { return p + ' ' + cur; }
        }
        function fmtDur(h) {
            if (!h) return '—';
            if (h < 1) return Math.round(h * 60) + ' min';
            if (h < 24) return h + 'h';
            var d = Math.floor(h / 24), r = h % 24;
            return d + 'j' + (r ? ' ' + r + 'h' : '');
        }
        function fmtSpd(kb) {
            if (!kb) return 'Illimitée';
            return kb >= 1024 ? (kb / 1024).toFixed(0) + ' Mbps' : kb + ' Kbps';
        }
        function fmtData(mb) {
            if (!mb) return 'Illimité';
            return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
        }
        function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
        function escAttr(s) { return (s || '').replace(/"/g, '&quot;'); }

        /* ══════════════════════════════════════════
           API
        ══════════════════════════════════════════ */
        function apiGet(path) {
            return fetch(CFG.backendUrl + path, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
            }).then(function (r) { if (!r.ok) throw r; return r.json(); });
        }
        function apiPost(path, data, timeoutMs) {
            return fetch(CFG.backendUrl + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(data),
                signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || 4000) : undefined
            }).then(function (r) { return r.json(); });
        }
   
});