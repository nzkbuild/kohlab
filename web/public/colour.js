// Sets the theme and the appearance choices before the first paint (index.html loads this synchronously; the CSP
// forbids inline scripts). The account's choices are mirrored in localStorage by store.ts. A missing or unknown value
// is the default, and storage that is off means the defaults too.
// data-theme follows the OS (light or dark), and follows it live. The default with no preference is dark.
(function () {
  var root = document.documentElement;
  var CHOICES = {
    tint: { key: "kohlab.tint", values: ["none", "rose", "peach", "mint", "sky", "lilac"], fallback: "none" },
    contrast: { key: "kohlab.contrast", values: ["standard", "medium", "high"], fallback: "standard" },
    density: { key: "kohlab.density", values: ["comfortable", "compact"], fallback: "comfortable" },
  };
  Object.keys(CHOICES).forEach(function (name) {
    var choice = CHOICES[name];
    var value = choice.fallback;
    try {
      var stored = localStorage.getItem(choice.key);
      if (choice.values.indexOf(stored) !== -1) value = stored;
    } catch (e) {
      /* storage is off: the default */
    }
    root.setAttribute("data-" + name, value);
  });

  var light = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function setTheme() {
    root.setAttribute("data-theme", light && light.matches ? "light" : "dark");
  }
  setTheme();
  if (light && light.addEventListener) light.addEventListener("change", setTheme);
})();
