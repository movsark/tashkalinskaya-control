import { createHash, randomUUID } from "node:crypto";

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { SpoilagePhotoView } from "@tashkalinskaya/contracts";
import sharp, { type Metadata } from "sharp";

import { DatabaseService } from "../database.service";
import { PrivateObjectStorage } from "./private-object-storage.service";

@Injectable()
export class SpoilagePhotoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: PrivateObjectStorage,
  ) {}

  async upload(
    file: Express.Multer.File | undefined,
    employeeId: string,
  ): Promise<SpoilagePhotoView> {
    if (!file?.buffer?.length) throw new ConflictException("Выберите фотографию");
    if (file.size > 10 * 1024 * 1024) throw new ConflictException("Фотография больше 10 МБ");
    const source = sharp(file.buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    let metadata: Metadata;
    try {
      metadata = await source.metadata();
    } catch {
      throw new ConflictException("Файл не является допустимой фотографией");
    }
    if (
      !metadata.format ||
      !["jpeg", "png", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new ConflictException("Разрешены только обычные JPEG, PNG и WebP");
    }
    const normalized = await sharp(file.buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({ fit: "inside", height: 1920, width: 1920, withoutEnlargement: true })
      .webp({ effort: 4, quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const width = normalized.info.width,
      height = normalized.info.height;
    if (!width || !height) throw new ConflictException("Не удалось определить размер фотографии");
    const id = randomUUID();
    const now = new Date();
    const key = `spoilage/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.webp`;
    await this.storage.put(key, normalized.data, "image/webp");
    try {
      await this.database.query(
        `insert into spoilage.photo_upload(id,storage_key,original_file_name,content_type,original_size,
           stored_size,sha256,width,height,uploaded_by) values($1,$2,$3,'image/webp',$4,$5,$6,$7,$8,$9)`,
        [
          id,
          key,
          safeFileName(file.originalname),
          file.size,
          normalized.data.length,
          createHash("sha256").update(normalized.data).digest("hex"),
          width,
          height,
          employeeId,
        ],
      );
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    return {
      contentType: "image/webp",
      height,
      id,
      originalFileName: safeFileName(file.originalname),
      storedSize: normalized.data.length,
      width,
    };
  }

  async read(photoId: string): Promise<{ body: Buffer; contentType: string }> {
    const result = await this.database.query<{ content_type: string; storage_key: string }>(
      `select storage_key,content_type from spoilage.photo_upload where id=$1 and status='ATTACHED'`,
      [photoId],
    );
    const photo = result.rows[0];
    if (!photo) throw new NotFoundException("Фотография не найдена");
    return { body: await this.storage.get(photo.storage_key), contentType: photo.content_type };
  }
}

function safeFileName(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || character === "/" || character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .trim();
  return (normalized || "photo").slice(0, 200);
}
