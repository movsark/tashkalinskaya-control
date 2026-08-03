import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#f4f1e9",
    description: "Производство, склад, логистика и табель фабрики",
    display: "standalone",
    icons: [
      {
        purpose: "any",
        sizes: "any",
        src: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    id: "/",
    lang: "ru",
    name: "Ташкалинская — внутренний контроль",
    orientation: "any",
    scope: "/",
    short_name: "Ташкалинская",
    start_url: "/start",
    theme_color: "#173c34",
  };
}
