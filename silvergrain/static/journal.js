function onSwipe(surface, change) {
  let start;
  let movedAt = -Infinity;
  surface.addEventListener("touchstart", (event) => {
    start = event.touches.length === 1 ? event.touches[0] : null;
  }, { passive: true });
  surface.addEventListener("touchcancel", () => { start = null; }, { passive: true });
  surface.addEventListener("touchend", (event) => {
    if (!start || event.touches.length) return;
    const end = event.changedTouches[0];
    const x = end.clientX - start.clientX;
    const y = end.clientY - start.clientY;
    start = null;
    if (Math.abs(x) < 60 || Math.abs(x) < 1.45 * Math.abs(y)) return;
    movedAt = performance.now();
    change(x < 0 ? 1 : -1);
  }, { passive: true });
  surface.addEventListener("click", (event) => {
    if (performance.now() - movedAt < 420) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}

function arrowStep(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  return event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
}

for (const slider of document.querySelectorAll("[data-slider]")) {
  const slides = Array.from(slider.querySelectorAll("[data-slide]"));
  if (slides.length < 2) continue;
  const dots = slider.querySelectorAll("[data-goto]");
  const controls = slider.querySelector("[data-controls]");
  const count = slider.querySelector("[data-count]");
  const move = (index) => {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, position) => { slide.hidden = position !== current; });
    dots.forEach((dot, position) => {
      if (position === current) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    count.textContent = String(current + 1).padStart(2, "0");
  };
  let current = 0;
  move(0);
  controls.hidden = false;
  slider.querySelector("[data-prev]").addEventListener("click", () => move(current - 1));
  slider.querySelector("[data-next]").addEventListener("click", () => move(current + 1));
  dots.forEach((dot) => dot.addEventListener("click", () => move(Number(dot.dataset.goto))));
  onSwipe(slider.querySelector("[data-slider-touch]"), (step) => move(current + step));
  slider.addEventListener("keydown", (event) => {
    if (event.target.closest("dialog")) return;
    const step = arrowStep(event);
    if (!step) return;
    event.preventDefault();
    const wasInSlide = slides[current].contains(document.activeElement);
    move(current + step);
    if (wasInSlide) slides[current].querySelector("a, button")?.focus({ preventScroll: true });
  });
}

for (const page of document.querySelectorAll("[data-paged]")) {
  const go = (step) => {
    const link = page.querySelector(step === 1 ? "[data-page-next]" : "[data-page-prev]");
    if (link) window.location.assign(link.href);
  };
  page.querySelectorAll("[data-page-touch]").forEach((area) => onSwipe(area, go));
  page.addEventListener("keydown", (event) => {
    if (!event.target.closest(".pager, .story-nav")) return;
    const step = arrowStep(event);
    if (step) {
      event.preventDefault();
      go(step);
    }
  });
}

for (const gallery of document.querySelectorAll("[data-gallery]")) {
  const dialog = gallery.querySelector("dialog");
  const frame = dialog.querySelector("img");
  gallery.querySelectorAll("[data-open-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      frame.src = button.dataset.src;
      frame.alt = button.querySelector("img").alt;
      dialog.showModal();
    });
  });
  dialog.querySelector("[data-close-photo]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

for (const order of document.querySelectorAll("[data-photo-order]")) {
  const refresh = () => {
    const rows = [...order.querySelectorAll("[data-photo]")];
    rows.forEach((row, index) => {
      row.querySelector('[data-move="-1"]').disabled = index === 0;
      row.querySelector('[data-move="1"]').disabled = index === rows.length - 1;
    });
  };
  order.addEventListener("click", (event) => {
    const move = event.target.closest("[data-move]");
    if (!move) return;
    const row = move.closest("[data-photo]");
    if (move.dataset.move === "-1") row.previousElementSibling.before(row);
    else row.nextElementSibling.after(row);
    refresh();
    const target = move.disabled ? row.querySelector("[data-move]:not(:disabled)") : move;
    target?.focus({ preventScroll: true });
  });
  refresh();
}

const picker = document.querySelector("[data-upload]");
if (picker && typeof DataTransfer === "function") {
  const uploads = document.querySelector("[data-uploads]");
  const template = document.querySelector("[data-upload-template]");
  const files = [];
  const key = (file) => JSON.stringify([file.name, file.size, file.lastModified]);
  const synchronize = () => {
    const transfer = new DataTransfer();
    files.forEach((entry, index) => {
      transfer.items.add(entry.file);
      entry.row.querySelector("[data-upload-alt]").name = `upload_alt_${index}`;
      entry.row.querySelector("[data-upload-caption]").name = `upload_caption_${index}`;
    });
    picker.files = transfer.files;
    picker.setCustomValidity(files.length > 10 ? "Select up to 10 photos per story." : "");
  };
  picker.addEventListener("change", () => {
    for (const file of picker.files) {
      if (files.some((entry) => key(entry.file) === key(file))) continue;
      const row = template.content.firstElementChild.cloneNode(true);
      const preview = URL.createObjectURL(file);
      row.querySelector("img").src = preview;
      row.querySelector(".upload-filename").textContent = file.name;
      const entry = { file, row };
      files.push(entry);
      uploads.append(row);
      row.querySelector("[data-remove-upload]").addEventListener("click", () => {
        files.splice(files.indexOf(entry), 1);
        URL.revokeObjectURL(preview);
        row.remove();
        synchronize();
        picker.focus({ preventScroll: true });
      });
    }
    synchronize();
  });
}
