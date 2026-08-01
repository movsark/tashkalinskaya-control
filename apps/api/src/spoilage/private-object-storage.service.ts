import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../config";

@Injectable()
export class PrivateObjectStorage {
  private readonly s3: S3Client | null;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.s3 = config.s3
      ? new S3Client({
          credentials: {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey,
          },
          endpoint: config.s3.endpoint,
          forcePathStyle: true,
          region: config.s3.region,
        })
      : null;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertStorageKey(key);
    if (this.s3 && this.config.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Body: body,
          Bucket: this.config.s3.bucket,
          CacheControl: "private, max-age=0, no-store",
          ContentType: contentType,
          Key: key,
          Metadata: { classification: "factory-private-photo" },
        }),
      );
      return;
    }
    const target = this.localPath(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    assertStorageKey(key);
    if (this.s3 && this.config.s3) {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.config.s3.bucket, Key: key }),
      );
      if (!response.Body) throw new Error("Photo object is empty");
      return Buffer.from(await response.Body.transformToByteArray());
    }
    return readFile(this.localPath(key));
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    if (this.s3 && this.config.s3) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.s3.bucket, Key: key }));
      return;
    }
    await unlink(this.localPath(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private localPath(key: string): string {
    return path.resolve(this.config.fileStorageLocalDirectory, key);
  }
}

function assertStorageKey(key: string): void {
  if (!/^spoilage\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/.test(key)) {
    throw new Error("Invalid private storage key");
  }
}
