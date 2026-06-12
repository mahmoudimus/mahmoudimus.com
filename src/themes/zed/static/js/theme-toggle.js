/* zed theme — light/dark toggle. The no-flash init runs inline in <head>;
   this only wires the button click + cross-tab sync. */
(function () {
  function current() {
    return (
      document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    );
  }
  function apply(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    try { localStorage.setItem("theme", mode); } catch (e) {}
  }
  function init() {
    var btn = document.querySelector(".theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        apply(current() === "dark" ? "light" : "dark");
      });
    }
  }
  window.addEventListener("storage", function (e) {
    if (e.key === "theme" && e.newValue) {
      document.documentElement.setAttribute("data-theme", e.newValue);
    }
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
