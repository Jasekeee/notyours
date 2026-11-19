// notyours site: copy-to-clipboard for the install command. No analytics, no network calls.
// After npm publish, set data-published="true" on [data-install]; the command switches to data-after-publish.
(function () {
  var box = document.querySelector('[data-install]');
  if (!box) return;
  var code = document.getElementById('install-cmd');
  var btn = document.getElementById('copy-btn');
  var status = document.getElementById('copy-status');

  function command() {
    return box.dataset.published === 'true' ? box.dataset.afterPublish : box.dataset.github;
  }

  code.textContent = command();

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function say(msg) {
    status.textContent = '';
    // Re-set on the next tick so screen readers announce repeated copies.
    setTimeout(function () { status.textContent = msg; }, 20);
  }

  btn.addEventListener('click', function () {
    var text = command();
    var done = function () { btn.textContent = 'Copied'; say('Copied: ' + text); setTimeout(reset, 1800); };
    var failed = function () { say('Copy failed. Select the command and copy it by hand.'); };
    function reset() { btn.textContent = 'Copy'; }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (fallbackCopy(text)) done(); else failed();
      });
    } else if (fallbackCopy(text)) {
      done();
    } else {
      failed();
    }
  });
})();
