import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../database.service";
import type { PrivateObjectStorage } from "./private-object-storage.service";
import { SpoilagePhotoService } from "./spoilage-photo.service";

describe("SpoilagePhotoService", () => {
  it("validates and normalizes an uploaded photo before private storage", async () => {
    const source = await sharp({
      create: { background: "#bc2d28", channels: 3, height: 2400, width: 3200 },
    })
      .jpeg()
      .toBuffer();
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const storage = { delete: vi.fn(), put: vi.fn().mockResolvedValue(undefined) };
    const service = new SpoilagePhotoService(
      database as unknown as DatabaseService,
      storage as unknown as PrivateObjectStorage,
    );

    const result = await service.upload(
      {
        buffer: source,
        encoding: "7bit",
        destination: "",
        fieldname: "file",
        filename: "",
        mimetype: "image/jpeg",
        originalname: "../../порча.jpg",
        path: "",
        size: source.length,
        stream: null!,
      },
      "00000000-0000-4000-8000-000000000001",
    );

    expect(result.contentType).toBe("image/webp");
    expect(Math.max(result.width, result.height)).toBe(1920);
    expect(result.originalFileName).not.toContain("/");
    expect(storage.put).toHaveBeenCalledOnce();
    expect(database.query).toHaveBeenCalledOnce();
  });

  it("rejects content that is not a supported image", async () => {
    const service = new SpoilagePhotoService(
      { query: vi.fn() } as unknown as DatabaseService,
      { delete: vi.fn(), put: vi.fn() } as unknown as PrivateObjectStorage,
    );
    await expect(
      service.upload(
        {
          buffer: Buffer.from("not-an-image"),
          encoding: "7bit",
          destination: "",
          fieldname: "file",
          filename: "",
          mimetype: "image/png",
          originalname: "fake.png",
          path: "",
          size: 12,
          stream: null!,
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("допустимой фотографией");
  });
});
