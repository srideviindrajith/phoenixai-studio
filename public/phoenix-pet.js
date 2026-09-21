/* =========================================================
   PHOENIX PET — site companion mascot (v2)
   Uses the real cropped phoenix artwork (not a drawn shape),
   animated purely with CSS transforms so it reads as a bird
   perched in the corner rather than a logo doing tricks.

   Settings (on/off, tip list) come from the server so the
   admin panel's Pet module can control it without a redeploy.
   ========================================================= */

(function () {
    'use strict';

    if (window.__phoenixPetLoaded) return;
    window.__phoenixPetLoaded = true;

    var STORAGE_KEY = 'phoenixPetDismissed';
    var DEFAULT_TIPS = [
        "Need a site? Tap \u201cStart Your Project\u201d.",
        "Browse the packages \u2014 there\u2019s one for every budget.",
        "Our AI agents can answer customers 24/7.",
        "Every site we build is mobile-first.",
        "Rising since day one. \uD83D\uDD25",
        "Questions? Scroll down to the contact form."
    ];

    try {
        if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch (e) { /* storage blocked — carry on */ }

    var reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    fetch('/api/pet-settings')
        .then(function (r) { return r.ok ? r.json() : { enabled: true, tips: DEFAULT_TIPS, petFeatureEnabled: false }; })
        .catch(function () { return { enabled: true, tips: DEFAULT_TIPS, petFeatureEnabled: false }; })
        .then(function (settings) {
            if (settings && settings.enabled === false) return;
            if (settings && settings.petFeatureEnabled !== true) return;
            var tips = (settings && Array.isArray(settings.tips) && settings.tips.length)
                ? settings.tips
                : DEFAULT_TIPS;
            init(tips);
        });

    function init(TIPS) {

        /* ---------- styles ---------- */

        var css = ''
            + '.phoenix-pet{position:fixed;right:26px;bottom:26px;width:64px;height:101px;'
            + 'z-index:9998;cursor:pointer;pointer-events:auto;'
            + 'transition:opacity .4s ease;opacity:0}'
            + '.phoenix-pet.is-ready{opacity:1}'
            + '.pp-body{width:100%;height:100%;transform-origin:50% 92%;'
            + 'animation:ppPerch 4.2s ease-in-out infinite;'
            + 'filter:drop-shadow(0 5px 12px rgba(255,90,0,.35))}'
            + '.pp-body img{width:100%;height:100%;object-fit:contain;display:block;'
            + 'transform-origin:50% 92%;transition:transform .5s cubic-bezier(.34,1.4,.64,1)}'
            + '.phoenix-pet:hover .pp-body{filter:drop-shadow(0 6px 18px rgba(255,90,0,.55))}'

            + '@keyframes ppPerch{0%,100%{transform:translateY(0) rotate(0)}'
            + '30%{transform:translateY(-2px) rotate(-1deg)}'
            + '60%{transform:translateY(0) rotate(.5deg)}}'

            + '.phoenix-pet.face-left .pp-body img{transform:scaleX(-1)}'

            + '.phoenix-pet.is-hop .pp-body{animation:ppHop .55s ease-in-out}'
            + '@keyframes ppHop{'
            + '0%{transform:translateY(0) rotate(0)}'
            + '30%{transform:translateY(-13px) rotate(-6deg)}'
            + '55%{transform:translateY(-16px) rotate(4deg)}'
            + '100%{transform:translateY(0) rotate(0)}}'

            + '.phoenix-pet.is-ruffle .pp-body img{animation:ppRuffle .4s ease-in-out}'
            + '@keyframes ppRuffle{'
            + '0%,100%{transform:scaleX(var(--pp-flip,1)) scaleY(1)}'
            + '35%{transform:scaleX(var(--pp-flip,1)) scaleY(.9) scaleX(calc(var(--pp-flip,1) * 1.06))}'
            + '70%{transform:scaleX(var(--pp-flip,1)) scaleY(1.04)}}'

            + '.phoenix-pet.is-startled .pp-body{animation:ppStartle .5s ease-in-out}'
            + '@keyframes ppStartle{'
            + '0%{transform:translateY(0) rotate(0)}'
            + '20%{transform:translateY(-6px) rotate(-8deg)}'
            + '40%{transform:translateY(-2px) rotate(7deg)}'
            + '60%{transform:translateY(-5px) rotate(-5deg)}'
            + '100%{transform:translateY(0) rotate(0)}}'

            + '.pp-dismiss{position:absolute;top:-4px;right:-4px;width:19px;height:19px;'
            + 'border-radius:50%;border:1px solid rgba(255,106,0,.35);'
            + 'background:rgba(12,11,9,.95);color:#D4D4D4;font-size:11px;line-height:1;'
            + 'display:flex;align-items:center;justify-content:center;cursor:pointer;'
            + 'opacity:0;transition:opacity .25s ease;padding:0;z-index:2}'
            + '.phoenix-pet:hover .pp-dismiss{opacity:1}'
            + '.pp-dismiss:hover{color:#FF6A00;border-color:rgba(255,106,0,.7)}'

            + '.pp-bubble{position:fixed;z-index:9999;max-width:210px;'
            + 'background:linear-gradient(135deg,rgba(20,17,14,.97),rgba(8,8,7,.95));'
            + 'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);'
            + 'border:1px solid rgba(255,106,0,.28);border-radius:14px;'
            + 'padding:11px 14px;color:#F5F5F5;font-size:13px;line-height:1.45;'
            + 'font-family:var(--font-ui,system-ui,sans-serif);'
            + 'box-shadow:0 10px 30px rgba(0,0,0,.5);'
            + 'opacity:0;transform:translateY(8px) scale(.94);pointer-events:none;'
            + 'transition:opacity .28s ease,transform .28s cubic-bezier(.22,1,.36,1)}'
            + '.pp-bubble.is-visible{opacity:1;transform:translateY(0) scale(1)}'

            + '.pp-ember{position:fixed;width:5px;height:5px;border-radius:50%;'
            + 'background:radial-gradient(circle,#FFC03A,#FF6A00 60%,transparent 72%);'
            + 'pointer-events:none;z-index:9997}'

            + '@media (max-width:768px){.phoenix-pet{width:50px;height:79px;right:16px;bottom:92px}'
            + '.pp-bubble{max-width:170px;font-size:12px}}'

            + '@media (prefers-reduced-motion:reduce){'
            + '.pp-body,.pp-body img{animation:none !important}}';

        var styleEl = document.createElement('style');
        styleEl.textContent = css;
        document.head.appendChild(styleEl);

        /* ---------- markup ---------- */

        var pet = document.createElement('div');
        pet.className = 'phoenix-pet';
        pet.setAttribute('role', 'button');
        pet.setAttribute('tabindex', '0');
        pet.setAttribute('aria-label', 'Phoenix mascot — tap for a tip');

        pet.innerHTML = ''
            + '<div class="pp-body"><img src="/pet-bird.png" alt="" aria-hidden="true"></div>'
            + '<button class="pp-dismiss" type="button" aria-label="Hide mascot">&times;</button>';

        var bubble = document.createElement('div');
        bubble.className = 'pp-bubble';
        bubble.setAttribute('role', 'status');

        function mount() {
            document.body.appendChild(pet);
            document.body.appendChild(bubble);
            requestAnimationFrame(function () { pet.classList.add('is-ready'); });
            scheduleNextHop();
            if (!reduceMotion && window.matchMedia('(pointer:fine)').matches) {
                window.addEventListener('pointermove', onPointerMove, { passive: true });
            }
            setTimeout(function () {
                if (document.body.contains(pet)) {
                    showBubble('Hi! I\u2019m Phoenix \u2014 tap me for a tip.');
                }
            }, 2600);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mount);
        } else {
            mount();
        }

        /* ---------- facing: turns to watch the cursor, like a perched bird ---------- */

        var facingLeft = false;

        function onPointerMove(e) {
            var rect = pet.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var isLeft = e.clientX < cx - 40;
            var isRight = e.clientX > cx + 40;
            if (isLeft && !facingLeft) {
                facingLeft = true;
                pet.classList.add('face-left');
            } else if (isRight && facingLeft) {
                facingLeft = false;
                pet.classList.remove('face-left');
            }
        }

        /* ---------- periodic bird-like behaviour ---------- */

        function scheduleNextHop() {
            var delay = 7000 + Math.random() * 9000;
            setTimeout(function () {
                if (!document.body.contains(pet)) return;
                if (Math.random() < 0.55) {
                    hop();
                } else {
                    ruffle();
                }
                scheduleNextHop();
            }, delay);
        }

        function hop() {
            if (reduceMotion) return;
            pet.classList.add('is-hop');
            setTimeout(function () { pet.classList.remove('is-hop'); }, 560);
        }

        function ruffle() {
            if (reduceMotion) return;
            pet.style.setProperty('--pp-flip', facingLeft ? -1 : 1);
            pet.classList.add('is-ruffle');
            setTimeout(function () { pet.classList.remove('is-ruffle'); }, 420);
        }

        /* ---------- bubble ---------- */

        var bubbleTimer = null;
        var tipIndex = Math.floor(Math.random() * TIPS.length);

        function showBubble(text) {
            bubble.textContent = text;
            var rect = pet.getBoundingClientRect();
            bubble.style.visibility = 'hidden';
            bubble.classList.add('is-visible');
            var bw = bubble.offsetWidth;
            var bh = bubble.offsetHeight;
            var left = rect.left + rect.width / 2 - bw / 2;
            left = Math.max(12, Math.min(left, window.innerWidth - bw - 12));
            bubble.style.left = left + 'px';
            bubble.style.top = Math.max(12, rect.top - bh - 12) + 'px';
            bubble.style.visibility = '';

            clearTimeout(bubbleTimer);
            bubbleTimer = setTimeout(hideBubble, 4200);
        }

        function hideBubble() {
            bubble.classList.remove('is-visible');
        }

        function nextTip() {
            tipIndex = (tipIndex + 1) % TIPS.length;
            return TIPS[tipIndex];
        }

        /* ---------- embers ---------- */

        function burstEmbers() {
            if (reduceMotion) return;
            var rect = pet.getBoundingClientRect();
            var originX = rect.left + rect.width / 2;
            var originY = rect.top + rect.height / 2;

            for (var i = 0; i < 10; i++) {
                (function (i) {
                    var el = document.createElement('div');
                    el.className = 'pp-ember';
                    el.style.left = originX + 'px';
                    el.style.top = originY + 'px';
                    document.body.appendChild(el);

                    var angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.5;
                    var dist = 30 + Math.random() * 38;
                    var dur = 600 + Math.random() * 380;

                    el.animate(
                        [
                            { transform: 'translate(0,0) scale(1)', opacity: 1 },
                            {
                                transform: 'translate(' + Math.cos(angle) * dist + 'px,' +
                                    (Math.sin(angle) * dist - 24) + 'px) scale(0)',
                                opacity: 0
                            }
                        ],
                        { duration: dur, easing: 'cubic-bezier(.2,.7,.4,1)' }
                    ).onfinish = function () { el.remove(); };
                })(i);
            }
        }

        /* ---------- interactions ---------- */

        function interact() {
            pet.classList.add('is-startled');
            burstEmbers();
            showBubble(nextTip());
            setTimeout(function () { pet.classList.remove('is-startled'); }, 520);
        }

        pet.addEventListener('click', function (e) {
            if (e.target.closest('.pp-dismiss')) return;
            interact();
        });

        pet.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                interact();
            }
        });

        pet.addEventListener('mouseenter', function () {
            if (!bubble.classList.contains('is-visible')) {
                showBubble(TIPS[tipIndex]);
            }
        });

        pet.querySelector('.pp-dismiss').addEventListener('click', function (e) {
            e.stopPropagation();
            hideBubble();
            pet.classList.remove('is-ready');
            setTimeout(function () {
                pet.remove();
                bubble.remove();
            }, 420);
            try { localStorage.setItem(STORAGE_KEY, '1'); } catch (err) { /* ignore */ }
        });
    }
})();
