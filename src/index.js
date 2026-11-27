const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ALLOWED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm"
];

const DEFAULT_ORIGIN = "https://videyku-two.vercel.app";
const ALLOWED_ORIGINS = [
  "https://videyku-two.vercel.app",
  "https://videyku-5rl.pages.dev",
];

function response(data, status = 200, origin = DEFAULT_ORIGIN) {
  return new Response(
    typeof data === "string" ? data : JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Content-Length, Range, X-Video-Title",
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges",
      },
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN;
    const respond = (data, status = 200) => response(data, status, corsOrigin);

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return respond({ error: "Origin tidak diizinkan" }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Content-Length, Range, X-Video-Title",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      if (url.pathname === "/api/upload" && request.method === "POST") {
        const type = request.headers.get("Content-Type") || "";
        const size = Number(request.headers.get("Content-Length") || 0);

        if (!ALLOWED_TYPES.includes(type)) {
          return respond({ error: "Format video tidak didukung" }, 415);
        }

        if (!size || size > MAX_FILE_SIZE) {
          return respond({ error: "Ukuran maksimal 100 MB" }, 413);
        }

        const id = crypto.randomUUID();
        const key = `${id}/video`;
        const title = "Video";

        const usageUpdate = await env.DB.prepare(
          "UPDATE storage_usage SET used_bytes = used_bytes + ? WHERE id = 1"
        ).bind(size).run();

        if (usageUpdate.meta.changes !== 1) {
          return respond({ error: "Pencatatan kapasitas gagal. Silakan coba lagi." }, 500);
        }

        try {
          await env.DB.prepare(
            `INSERT INTO videos
             (id, title, storage_key, content_type, size_bytes,
              expires_at, status)
             VALUES (?, ?, ?, ?, ?, unixepoch() + 2592000, 'pending')`
          ).bind(id, title, key, type, size).run();

          await env.VIDEOS_BUCKET.put(key, request.body, {
            httpMetadata: { contentType: type },
          });

          await env.DB.prepare(
            "UPDATE videos SET status = 'ready' WHERE id = ?"
          ).bind(id).run();

          return respond({
            success: true,
            id,
            url: `${url.origin}/api/play/${id}`,
          });
        } catch (error) {
          await env.VIDEOS_BUCKET.delete(key).catch(() => {});
          await env.DB.prepare(
            "DELETE FROM videos WHERE id = ?"
          ).bind(id).run();
          await env.DB.prepare(
            "UPDATE storage_usage SET used_bytes = MAX(0, used_bytes - ?) WHERE id = 1"
          ).bind(size).run();
          throw error;
        }
      }

      if (url.pathname.startsWith("/api/video/") &&
          request.method === "GET") {
        const id = url.pathname.split("/").pop();

        const video = await env.DB.prepare(
          `SELECT id, title, content_type, size_bytes
           FROM videos WHERE id = ? AND status = 'ready'
           AND expires_at > unixepoch()`
        ).bind(id).first();

        if (!video) {
          return respond({ error: "Video tidak ditemukan" }, 404);
        }

        return respond({
          ...video,
          playback_url: `${url.origin}/api/play/${id}`,
        });
      }

      if (url.pathname.startsWith("/api/play/") &&
          ["GET", "HEAD"].includes(request.method)) {
        const id = url.pathname.split("/").pop();

        const video = await env.DB.prepare(
          `SELECT storage_key, content_type
           FROM videos WHERE id = ? AND status = 'ready'
           AND expires_at > unixepoch()`
        ).bind(id).first();

        if (!video) {
          return new Response("Video tidak ditemukan", { status: 404 });
        }

        const object = await env.VIDEOS_BUCKET.get(
          video.storage_key,
          { range: request.headers }
        );

        if (!object) {
          return new Response("Video tidak ditemukan", { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("Content-Type", video.content_type);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=3600");

        let status = 200;

        if (object.range) {
          const start = object.range.offset ?? 0;
          const length = object.range.length ?? object.size;
          headers.set(
            "Content-Range",
            `bytes ${start}-${start + length - 1}/${object.size}`
          );
          status = 206;
        }

        headers.set(
          "Content-Length",
          String(object.range?.length ?? object.size)
        );

        return new Response(
          request.method === "HEAD" ? null : object.body,
          { status, headers }
        );
      }

      return respond({ error: "Alamat API tidak ditemukan" }, 404);
    } catch (error) {
      return respond({ error: "Terjadi kesalahan pada server" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const expired = await env.DB.prepare(
      `SELECT id, storage_key
       FROM videos
       WHERE expires_at <= unixepoch()
       AND status IN ('ready', 'pending')
       ORDER BY expires_at ASC
       LIMIT 1000`
    ).all();

    const batchSize = 25;
    for (let i = 0; i < expired.results.length; i += batchSize) {
      const batch = expired.results.slice(i, i + batchSize);

      await Promise.all(batch.map(async video => {
        try {
          await env.VIDEOS_BUCKET.delete(video.storage_key);

          await env.DB.batch([
            env.DB.prepare(
              `UPDATE storage_usage
               SET used_bytes = MAX(0, used_bytes - (
                 SELECT CASE
                   WHEN status IN ('ready', 'pending') THEN size_bytes
                   ELSE 0
                 END
                 FROM videos WHERE id = ?
               ))
               WHERE id = 1`
            ).bind(video.id),
            env.DB.prepare(
              "UPDATE videos SET status = 'deleted' WHERE id = ? AND status IN ('ready', 'pending')"
            ).bind(video.id)
          ]);
        } catch (error) {
          console.error("Gagal menghapus video kedaluwarsa:", video.id, error);
        }
      }));
    }
  },
};
