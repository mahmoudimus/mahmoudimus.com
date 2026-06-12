/* zed/Vaul-style mobile drawer: toggles body.drawer-open, which slides the
   bottom sheet up and scales the page behind it (see theme.css). Closes on
   scrim click, link click, or Escape. */
(function () {
  var btn = document.querySelector(".menu-toggle");
  var scrim = document.querySelector(".drawer-scrim");
  var drawer = document.querySelector(".mobile-drawer");
  if (!btn || !drawer || !scrim) return;

  function set(open) {
    document.body.classList.toggle("drawer-open", open);
    btn.setAttribute("aria-expanded", String(open));
  }
  btn.addEventListener("click", function () {
    set(!document.body.classList.contains("drawer-open"));
  });
  scrim.addEventListener("click", function () { set(false); });
  drawer.addEventListener("click", function (e) {
    if (e.target.closest("a")) set(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") set(false);
  });
})();
