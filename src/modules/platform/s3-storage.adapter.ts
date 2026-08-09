import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { StoragePort } from './media.service';

/**
 * S3-compatible StoragePort (MinIO in dev/CI, S3 or compatible in prod),
 * selected when S3_ENDPOINT is configured. The bucket is created on first
 * use so fresh environments need no manual step.
 */
export class S3Storage extends StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketEnsured = false;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.get<string>('S3_BUCKET') ?? 'crm';
    this.client = new S3Client({
      endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
      region: config.get<string>('S3_REGION') ?? 'eu-west-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
      },
    });
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(name)) {
        throw err;
      }
    }
    this.bucketEnsured = true;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
    );
  }

  async get(key: string): Promise<Buffer> {
    await this.ensureBucket();
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return Buffer.from(await result.Body!.transformToByteArray());
  }
}
