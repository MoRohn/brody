(function () {
  var root = document.documentElement;
  var button = document.querySelector(".theme-toggle");
  if (!button) return;

  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("brody-site-theme", theme); } catch (e) { /* private mode */ }
    var dark = theme === "dark";
    button.setAttribute("aria-pressed", dark ? "true" : "false");
    button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    var label = button.querySelector(".theme-label");
    if (label) label.textContent = dark ? "Light" : "Dark";
  }

  button.addEventListener("click", function () {
    apply(current() === "dark" ? "light" : "dark");
  });
  apply(current());

  document.querySelectorAll("nav a").forEach(function (link) {
    link.addEventListener("click", function () {
      var menu = link.closest("details");
      if (menu && window.matchMedia("(max-width: 1040px)").matches) menu.open = false;
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    document.querySelectorAll("nav details[open]").forEach(function (menu) { menu.open = false; });
  });
})();
