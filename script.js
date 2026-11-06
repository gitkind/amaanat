const header = document.getElementById("header");
const menu = document.getElementById("menu");
const nav = document.getElementById("nav");

window.addEventListener(
  "scroll",
  () => {
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  },
  { passive: true }
);

menu.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});

nav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    nav.classList.remove("is-open");
    menu.setAttribute("aria-expanded", "false");
  });
});
