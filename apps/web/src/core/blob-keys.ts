// Where a blob's bytes live in R2. Each blobs row has its own generation, set
// when the row is made, and its bytes sit under it: a blob the purge removes
// and someone uploads again gets a new row and a new generation, so a delete
// of the old bytes that arrives late never reaches the new ones. Rows from
// before generations keep their bytes at `blobs/<sha256>`.

/** The R2 key of a blob row's bytes. */
export const objectKey = (sha256: string, generation: string | null): string =>
  generation === null ? `blobs/${sha256}` : `blobs/${sha256}/${generation}`

/** The R2 key of the bytes the blob's row names now. */
export const blobObjectKey = async (
  DB: D1Database,
  sha256: string,
): Promise<string> => {
  const row = await DB.prepare('select generation from blobs where sha256 = ?')
    .bind(sha256)
    .first<{ generation: string | null }>()
  return objectKey(sha256, row?.generation ?? null)
}

/** A blob's bytes, or null when R2 holds none. */
export const getBlob = async (
  bindings: { readonly DB: D1Database; readonly BLOBS: R2Bucket },
  sha256: string,
): Promise<R2ObjectBody | null> =>
  bindings.BLOBS.get(await blobObjectKey(bindings.DB, sha256))
