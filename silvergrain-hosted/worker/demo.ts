import type { Card, Photo } from "./types";

const samplePhoto = (key: string, alt: string, caption: string, title?: string, story?: string): Photo => ({
  id: key, alt, caption, title, story, width: 1536, height: 1024,
  full: `/static/demo/${key}.webp`, small: `/static/demo/${key}-small.webp`,
});

type Sample = Card & { photos: Photo[] };

function sample(
  slug: string, title: string, caption: string, story: string, category: string,
  location: string, date: string, photos: Photo[],
): Sample {
  const published = Date.parse(date) / 1000;
  return {
    id: `sample-${slug}`, slug, title, caption, story, category, location, photo_date: date,
    published_at: published, updated_at: published, revision: 1, demo: true,
    photo: photos[0], photo_count: photos.length, photos,
  };
}

export const samples = [
  sample(
    "where-the-light-falls", "Where the light falls",
    "Before sunrise in the Dolomites, when the valley belongs to the fog.",
    "The ridgeline appeared first. For a few minutes it was the only shape above the valley, and the low cloud turned everything beneath it a soft, even gray.\n\nBy the lake, the same mountains almost disappeared into their reflection. These two frames hold that small change in light.",
    "Landscape", "Dolomites, Italy", "2026-10-18", [
      samplePhoto("dolomites", "Jagged alpine peaks rising above a dark valley filled with fog", "The ridgeline before sunrise.",
        "Where the light falls",
        "The ridgeline appeared first. For a few minutes it was the only shape above the valley, and the low cloud turned everything beneath it a soft, even gray."),
      samplePhoto("alpine-lake", "A foggy alpine lake reflecting the mountains", "The still water at first light.",
        "At first light",
        "By the lake, the mountains almost disappeared into their reflection. The water held the same soft gray as the sky, until the first breeze broke the surface."),
    ],
  ),
  sample(
    "between-the-arches", "Between the arches",
    "A long shadow, a quiet arcade, and a figure at the far end.",
    "The arches made a rhythm out of an otherwise quiet afternoon. I waited until a figure entered the far arch and the pavement held just enough light to trace the way through.",
    "Architecture", "Bologna, Italy", "2026-10-04",
    [samplePhoto("arcade", "A solitary figure at the end of a row of stone arches", "Late light across the arcade.")],
  ),
  sample(
    "the-shape-of-water", "The shape of water",
    "White surf against the dark edge of the Ligurian coast.",
    "The swell kept changing the outline of the rock. From a low vantage point, each wave drew a different white edge against the stone.",
    "Seascape", "Liguria, Italy", "2026-09-21",
    [samplePhoto("coast", "White surf curls around a dark rocky headland", "Looking out from the rocks.")],
  ),
  sample(
    "a-street-in-silence", "A street in silence",
    "A bicycle, shuttered windows, and the last strip of daylight.",
    "A narrow street held the day's last light long after the square had gone gray. The bicycle beside the wall was the only thing that suggested someone would be back.",
    "Street", "Tuscany, Italy", "2026-09-09",
    [samplePhoto("street", "A bicycle against the wall of a narrow Italian street", "Daylight at the far end of the street.")],
  ),
];

export const sampleBySlug = new Map(samples.map((entry) => [entry.slug, entry]));
