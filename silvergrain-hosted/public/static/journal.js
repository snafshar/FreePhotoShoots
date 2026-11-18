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

for (const page of document.querySelectorAll("[data-paged]")) {
  const owned = (element) => element.closest("[data-paged]") === page;
  const go = (step) => {
    const selector = step === 1 ? "[data-page-next]" : "[data-page-prev]";
    const link = [...page.querySelectorAll(selector)].find(owned);
    if (link) window.location.assign(link.href);
  };
  page.querySelectorAll("[data-page-touch]").forEach((area) => {
    if (owned(area)) onSwipe(area, go);
  });
  page.addEventListener("keydown", (event) => {
    if (!owned(event.target) || event.target.closest("dialog")) return;
    if (event.target !== page && !event.target.closest(".pager, .story-nav, .magazine-photo-open")) return;
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

const hostedEditor = document.querySelector("[data-hosted-editor]");
if (hostedEditor) {
  const picker = hostedEditor.querySelector("[data-hosted-upload]");
  const uploads = hostedEditor.querySelector("[data-hosted-uploads]");
  const template = hostedEditor.querySelector("[data-hosted-upload-template]");
  const status = hostedEditor.querySelector("[data-upload-status]");
  const queue = hostedEditor.elements.namedItem("uploads");
  const postId = hostedEditor.elements.namedItem("post_id").value;
  const csrf = hostedEditor.elements.namedItem("csrf").value;
  const base = `/admin/uploads/${postId}`;
  const buttons = [...hostedEditor.querySelectorAll('button[type="submit"]')];
  const entries = [];
  let running = false;

  const showStatus = (message) => {
    status.textContent = message;
    status.hidden = !message;
  };

  const sync = () => {
    queue.value = JSON.stringify(entries.map(({ id, row }) => ({
      id, alt: row.querySelector("[data-upload-alt]").value,
      caption: row.querySelector("[data-upload-caption]").value,
      title: row.querySelector("[data-upload-title]").value,
      story: row.querySelector("[data-upload-story]").value,
    })));
    entries.forEach(({ row }, i) => {
      row.querySelector('[data-shift="-1"]').disabled = i === 0;
      row.querySelector('[data-shift="1"]').disabled = i === entries.length - 1;
    });
  };

  function addEntry(id, name, alt = "", caption = "", title = "", story = "") {
    const row = template.content.firstElementChild.cloneNode(true);
    const entry = { id, row };
    row.querySelector("img").src = `${base}/${id}`;
    row.querySelector(".upload-filename").textContent = name;
    row.querySelector("[data-upload-alt]").value = alt;
    row.querySelector("[data-upload-caption]").value = caption;
    row.querySelector("[data-upload-title]").value = title;
    row.querySelector("[data-upload-story]").value = story;
    row.addEventListener("input", sync);
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-remove-upload]")) {
        entries.splice(entries.indexOf(entry), 1);
        row.remove();
        sync();
        picker.focus();
        return;
      }
      const button = event.target.closest("[data-shift]");
      if (!button) return;
      const from = entries.indexOf(entry);
      const to = from + Number(button.dataset.shift);
      if (to < 0 || to >= entries.length) return;
      const other = entries[to].row;
      if (to < from) other.before(row);
      else other.after(row);
      [entries[from], entries[to]] = [entries[to], entries[from]];
      sync();
      const focus = button.disabled ? row.querySelector("[data-shift]:not(:disabled)") : button;
      focus?.focus({ preventScroll: true });
    });
    entries.push(entry);
    uploads.append(row);
  }

  function webp(image, edge, quality) {
    const ratio = Math.min(1, edge / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        canvas.width = canvas.height = 1;
        if (blob?.type === "image/webp") resolve(blob);
        else reject(new Error("This browser could not export the photo as WebP."));
      }, "image/webp", quality);
    });
  }

  async function upload(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 16 * 1024 * 1024) {
      throw new Error("Choose a JPEG, PNG, or WebP file up to 16 MB.");
    }
    const image = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      if (image.width * image.height > 65_000_000) throw new Error("Choose a photo under 65 megapixels.");
      const full = await webp(image, 1920, 0.87);
      const small = await webp(image, 720, 0.81);
      const response = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Silvergrain-CSRF": csrf,
          "X-Silvergrain-Full-Bytes": String(full.size),
        },
        body: new Blob([full, small]),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.id !== "string") throw new Error(result.error || "Upload failed. Try again.");
      addEntry(result.id, file.name);
      sync();
    } finally {
      image.close();
    }
  }

  JSON.parse(queue.value).forEach(({ id, alt, caption, title, story }, i) =>
    addEntry(id, `Uploaded photo ${i + 1}`, alt, caption, title ?? "", story ?? ""));
  sync();
  picker.addEventListener("change", async () => {
    if (running) return;
    const files = [...picker.files];
    picker.value = "";
    if (!files.length) return;
    const kept = hostedEditor.querySelectorAll('input[name="remove_photo"]:not(:checked)').length;
    if (kept + entries.length + files.length > 10) {
      showStatus("Choose up to ten photographs per story.");
      return;
    }
    running = true;
    picker.disabled = true;
    buttons.forEach((button) => { button.disabled = true; });
    const errors = [];
    try {
      for (const [index, file] of files.entries()) {
        showStatus(`Uploading ${index + 1} of ${files.length}…`);
        try {
          await upload(file);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
      }
      showStatus(errors.length ? errors.join(" ") : `${entries.length} new ${entries.length === 1 ? "photo" : "photos"} ready to save.`);
    } finally {
      running = false;
      picker.disabled = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
  hostedEditor.addEventListener("submit", (event) => {
    if (running) event.preventDefault();
    sync();
  });
}


const publicationOrder = document.querySelector("[data-publication-order]");
if (publicationOrder) {
  const list = publicationOrder.querySelector("[data-publication-list]");
  const rows = () => [...list.querySelectorAll("[data-publication-photo]")];
  function updatePositions() {
    const items = rows();
    items.forEach((row, index) => {
      row.querySelector('input[type="number"]').value = String(index + 1);
      row.querySelector('[data-publication-move="-1"]').disabled = index === 0;
      row.querySelector('[data-publication-move="1"]').disabled = index === items.length - 1;
    });
  }
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-publication-move]");
    if (!button || button.disabled) return;
    const row = button.closest("[data-publication-photo]");
    if (button.dataset.publicationMove === "-1") row.previousElementSibling.before(row);
    else row.nextElementSibling.after(row);
    updatePositions();
    const focus = button.disabled ? row.querySelector("[data-publication-move]:not(:disabled)") : button;
    focus?.focus({ preventScroll: true });
  });
  list.addEventListener("change", (event) => {
    if (!event.target.matches('input[type="number"]')) return;
    const items = rows();
    const destination = event.target.valueAsNumber;
    if (!Number.isInteger(destination) || destination < 1 || destination > items.length) return;
    const row = event.target.closest("[data-publication-photo]");
    const index = items.indexOf(row);
    if (destination - 1 < index) items[destination - 1].before(row);
    else if (destination - 1 > index) items[destination - 1].after(row);
    updatePositions();
    row.querySelector('input[type="number"]').focus({ preventScroll: true });
  });
  updatePositions();
}
