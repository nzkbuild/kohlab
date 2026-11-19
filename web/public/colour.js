// Sets the colour mode before the first paint (index.html loads this synchronously; the CSP forbids inline scripts).
// Soft is the default. The account's choice is mirrored in localStorage by store.ts, and only "0" means Plain.
(function () {
  var plain = false;
  try {
    plain = localStorage.getItem("kohlab.softColour") === "0";
  } catch (e) {
    /* storage is off: soft */
  }
  if (!plain) document.documentElement.setAttribute("data-colour", "soft");
})();
