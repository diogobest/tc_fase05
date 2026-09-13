import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Pool, PoolClient } from "pg";
import defaultPool from "../db/pool.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { AppError, errorHandler, notFound } from "./shared/errors.ts";
import {
  createAccessToken,
  tokenHash,
  verifyAccessToken,
} from "./shared/tokens.ts";
import {
  object,
  oneOf,
  optionalString,
  string,
  uuid,
} from "./shared/validation.ts";
import {
  priorities,
  statuses,
  type IncidentStatus,
  validateTransition,
} from "./modules/incidents/domain.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const route =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const incidentSelect = `SELECT i.id, i.requester_id AS "requesterId", i.assignee_id AS "assigneeId",
 i.category_id AS "categoryId", c.name AS "categoryName", i.title, i.description, i.address,
 i.location_details AS "locationDetails", i.latitude::float8, i.longitude::float8, i.status,
 i.priority, i.solution, i.resolved_at AS "resolvedAt", i.version, i.created_at AS "createdAt",
 i.updated_at AS "updatedAt" FROM incidents i JOIN categories c ON c.id=i.category_id`;

export function createApp(
  pool: Pool = defaultPool,
  config: AppConfig = loadConfig(),
) {
  const app = express();
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );

    if (req.method === "OPTIONS") return res.sendStatus(204);

    next();
  });

  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      const match = req.headers.authorization?.match(/^Bearer (.+)$/);

      if (!match)
        throw new AppError(
          401,
          "AUTHENTICATION_REQUIRED",
          "A bearer token is required",
        );

      try {
        const payload = await verifyAccessToken(match[1]!, config.jwtSecret);
        const active = await pool.query(
          "SELECT 1 FROM users WHERE id=$1 AND active",
          [payload.sub],
        );

        if (!active.rowCount) throw new Error("inactive");

        req.auth = { userId: payload.sub, role: payload.role };
      } catch (error) {
        if (error instanceof AppError) throw error;

        throw new AppError(
          401,
          "INVALID_ACCESS_TOKEN",
          "The access token is invalid",
        );
      }

      next();
    })().catch(next);
  };
  const manager = (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.role !== "manager")
      return next(
        new AppError(403, "MANAGER_REQUIRED", "Manager access is required"),
      );

    next();
  };

  const visibleIncident = async (req: Request, lock = false) => {
    const id = uuid(req.params.id, "id");
    const result = await pool.query(
      `${incidentSelect} WHERE i.id=$1 ${lock ? "FOR UPDATE OF i" : ""}`,
      [id],
    );
    const incident = result.rows[0];

    if (
      !incident ||
      (req.auth!.role === "requester" &&
        incident.requesterId !== req.auth!.userId)
    ) {
      throw new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
    }

    return incident;
  };

  async function tokens(
    user: { id: string; role: "requester" | "manager" },
    client: Pool | PoolClient = pool,
  ) {
    const accessToken = await createAccessToken(
      { sub: user.id, role: user.role },
      config.jwtSecret,
      config.accessTokenTtlSeconds,
    );
    const refreshToken =
      `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");

    await client.query(
      `INSERT INTO refresh_tokens(user_id, token_hash, expires_at)
                       VALUES($1,$2,now()+($3 * interval '1 second'))`,
      [user.id, await tokenHash(refreshToken), config.refreshTokenTtlSeconds],
    );

    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: config.accessTokenTtlSeconds,
    };
  }

  const health = route(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "up" });
    } catch {
      res.status(503).json({ status: "degraded", database: "down" });
    }
  });

  app.use(express.json());
  app.get("/health", health);
  app.get("/openapi.json", (_req, res) =>
    res.sendFile("openapi.json", { root: process.cwd() }),
  );
  app.get("/docs", (_req, res) =>
    res
      .type("html")
      .send(
        `<!doctype html><title>Resolve Aí API</title><div id="swagger-ui"></div><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'})</script>`,
      ),
  );

  const api = express.Router();

  api.get("/health", health);
  api.post(
    "/auth/register",
    route(async (req, res) => {
      const body = object(req.body);
      const name = string(body.name, "name", 2, 150);
      const email = string(body.email, "email", 3, 320).toLowerCase();

      if (!/^\S+@\S+\.\S+$/.test(email))
        throw new AppError(422, "VALIDATION_ERROR", "email is invalid", [
          { field: "email" },
        ]);

      const password = string(body.password, "password", 8, 200);
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });

      try {
        const result = await pool.query(
          `INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3)
                                      RETURNING id,name,email,role,created_at AS "createdAt"`,
          [name, email, hash],
        );
        res.status(201).json(result.rows[0]);
      } catch (error: any) {
        if (error?.code === "23505")
          throw new AppError(
            409,
            "EMAIL_ALREADY_EXISTS",
            "Email is already registered",
          );
        throw error;
      }
    }),
  );

  api.post(
    "/auth/login",
    route(async (req, res) => {
      const body = object(req.body);
      const email = string(body.email, "email").toLowerCase();
      const password = string(body.password, "password");
      const result = await pool.query(
        "SELECT id,name,email,password_hash,role FROM users WHERE email=$1 AND active",
        [email],
      );
      const user = result.rows[0];

      if (!user || !(await Bun.password.verify(password, user.password_hash)))
        throw new AppError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is invalid",
        );

      res.json({
        ...(await tokens(user)),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    }),
  );

  api.post(
    "/auth/refresh",
    route(async (req, res) => {
      const refreshToken = string(
        object(req.body).refreshToken,
        "refreshToken",
      );
      const hash = await tokenHash(refreshToken);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT rt.id,u.id AS user_id,u.role FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
                                        WHERE rt.token_hash=$1 AND rt.revoked_at IS NULL AND rt.expires_at>now() AND u.active FOR UPDATE OF rt`,
          [hash],
        );
        const row = result.rows[0];

        if (!row)
          throw new AppError(
            401,
            "INVALID_REFRESH_TOKEN",
            "Refresh token is invalid or expired",
          );

        await client.query(
          "UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1",
          [row.id],
        );
        const next = await tokens({ id: row.user_id, role: row.role }, client);
        await client.query("COMMIT");

        res.json(next);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  api.post(
    "/auth/logout",
    authenticate,
    route(async (req, res) => {
      const refreshToken = string(
        object(req.body).refreshToken,
        "refreshToken",
      );
      await pool.query(
        "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL",
        [req.auth!.userId, await tokenHash(refreshToken)],
      );
      res.sendStatus(204);
    }),
  );

  api.get(
    "/me",
    authenticate,
    route(async (req, res) => {
      const result = await pool.query(
        `SELECT id,name,email,role,created_at AS "createdAt",updated_at AS "updatedAt" FROM users WHERE id=$1`,
        [req.auth!.userId],
      );
      res.json(result.rows[0]);
    }),
  );

  api.get(
    "/categories",
    authenticate,
    route(async (_req, res) => {
      const result = await pool.query(
        `SELECT id,name,slug FROM categories WHERE active ORDER BY name`,
      );
      res.json({ data: result.rows });
    }),
  );

  api.post(
    "/incidents",
    authenticate,
    route(async (req, res) => {
      if (req.auth!.role !== "requester")
        throw new AppError(
          403,
          "REQUESTER_REQUIRED",
          "Only requesters can create incidents",
        );
      const b = object(req.body);
      const categoryId = uuid(b.categoryId, "categoryId");
      const category = await pool.query(
        "SELECT 1 FROM categories WHERE id=$1 AND active",
        [categoryId],
      );
      if (!category.rowCount)
        throw new AppError(
          422,
          "INVALID_CATEGORY",
          "Category does not exist or is inactive",
        );
      const latitude = b.latitude == null ? null : Number(b.latitude);
      const longitude = b.longitude == null ? null : Number(b.longitude);
      if (
        (latitude != null &&
          (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
        (longitude != null &&
          (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))
      )
        throw new AppError(422, "VALIDATION_ERROR", "Invalid coordinates");
      const result = await pool.query(
        `INSERT INTO incidents(requester_id,category_id,title,description,address,location_details,latitude,longitude)
                                    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          req.auth!.userId,
          categoryId,
          string(b.title, "title", 3, 200),
          string(b.description, "description", 3),
          string(b.address, "address", 1, 300),
          optionalString(b.locationDetails, "locationDetails", 300) ?? null,
          latitude,
          longitude,
        ],
      );
      const created = await pool.query(`${incidentSelect} WHERE i.id=$1`, [
        result.rows[0].id,
      ]);
      res.status(201).json(created.rows[0]);
    }),
  );

  api.get(
    "/incidents",
    authenticate,
    route(async (req, res) => {
      const page = Math.max(
        1,
        Number.parseInt(String(req.query.page ?? "1")) || 1,
      );
      const pageSize = Math.min(
        100,
        Math.max(1, Number.parseInt(String(req.query.pageSize ?? "20")) || 20),
      );
      const where: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        where.push(sql.replace("?", `$${values.length}`));
      };

      if (req.auth!.role === "requester")
        add("i.requester_id=?", req.auth!.userId);
      if (req.query.status)
        add("i.status=?", oneOf(req.query.status, statuses, "status"));
      if (req.query.priority)
        add("i.priority=?", oneOf(req.query.priority, priorities, "priority"));
      if (req.query.categoryId)
        add("i.category_id=?", uuid(req.query.categoryId, "categoryId"));
      if (req.query.assigneeId)
        add("i.assignee_id=?", uuid(req.query.assigneeId, "assigneeId"));
      if (req.query.createdFrom)
        add("i.created_at>=?", string(req.query.createdFrom, "createdFrom"));
      if (req.query.createdTo)
        add("i.created_at<=?", string(req.query.createdTo, "createdTo"));

      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const count = await pool.query(
        `SELECT count(*) FROM incidents i ${clause}`,
        values,
      );
      const total = Number(count.rows[0].count);
      const sort: Record<string, string> = {
        createdAt: "i.created_at ASC",
        "-createdAt": "i.created_at DESC",
        priority: "i.priority ASC",
        "-priority": "i.priority DESC",
      };
      values.push(pageSize, (page - 1) * pageSize);
      const rows = await pool.query(
        `${incidentSelect} ${clause} ORDER BY ${sort[String(req.query.sort)] ?? "i.created_at DESC"} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      res.json({
        data: rows.rows,
        meta: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      });
    }),
  );

  api.get(
    "/incidents/:id",
    authenticate,
    route(async (req, res) => res.json(await visibleIncident(req))),
  );

  api.get(
    "/incidents/:id/history",
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      const result = await pool.query(
        `SELECT * FROM (
      SELECT id,'status' AS type,previous_status AS "previousValue",new_status AS "newValue",changed_by AS "changedBy",observation AS reason,created_at AS "createdAt" FROM status_history WHERE incident_id=$1
      UNION ALL SELECT id,'assignment',previous_assignee_id::text,new_assignee_id::text,changed_by,reason,created_at FROM assignment_history WHERE incident_id=$1
      UNION ALL SELECT id,'priority',previous_priority::text,new_priority::text,changed_by,reason,created_at FROM priority_history WHERE incident_id=$1
    ) history ORDER BY "createdAt",id`,
        [incident.id],
      );
      res.json({ data: result.rows });
    }),
  );
  api.post(
    "/incidents/:id/comments",
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      const body = string(object(req.body).body, "body", 1);
      const result = await pool.query(
        `INSERT INTO comments(incident_id,author_id,body) VALUES($1,$2,$3) RETURNING id,incident_id AS "incidentId",author_id AS "authorId",body,created_at AS "createdAt"`,
        [incident.id, req.auth!.userId, body],
      );
      res.status(201).json(result.rows[0]);
    }),
  );
  api.get(
    "/incidents/:id/comments",
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      const result = await pool.query(
        `SELECT c.id,c.author_id AS "authorId",u.name AS "authorName",c.body,c.created_at AS "createdAt" FROM comments c JOIN users u ON u.id=c.author_id WHERE incident_id=$1 ORDER BY c.created_at,c.id`,
        [incident.id],
      );
      res.json({ data: result.rows });
    }),
  );
  const imageTypes: Record<string, (data: Buffer) => boolean> = {
    "image/jpeg": (data) =>
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff,
    "image/png": (data) =>
      data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/webp": (data) =>
      data.subarray(0, 4).toString() === "RIFF" &&
      data.subarray(8, 12).toString() === "WEBP",
  };
  api.post(
    "/incidents/:id/attachments",
    express.raw({
      type: Object.keys(imageTypes),
      limit: config.maxUploadBytes,
    }),
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      if (
        req.auth!.role !== "requester" ||
        incident.requesterId !== req.auth!.userId
      )
        throw new AppError(
          403,
          "INCIDENT_OWNER_REQUIRED",
          "Only the requester can upload attachments",
        );
      const mime = String(req.headers["content-type"] ?? "").split(";")[0]!;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!imageTypes[mime])
        throw new AppError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Only JPEG, PNG and WebP images are accepted",
        );
      if (!data.length || !imageTypes[mime](data))
        throw new AppError(
          415,
          "INVALID_IMAGE_CONTENT",
          "File content does not match its media type",
        );
      const count = await pool.query(
        "SELECT count(*) FROM attachments WHERE incident_id=$1",
        [incident.id],
      );
      if (Number(count.rows[0].count) >= 5)
        throw new AppError(
          409,
          "ATTACHMENT_LIMIT_REACHED",
          "An incident can have at most 5 attachments",
        );
      const extension: { [key: string]: string } = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };
      const key = `${incident.id}/${crypto.randomUUID()}.${extension[mime]}`;
      const target = path.resolve(config.uploadDirectory, key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: "wx" });
      const fileName = string(
        req.headers["x-file-name"] ?? `image.${extension[mime]}`,
        "x-file-name",
        1,
        255,
      );
      const result = await pool.query(
        `INSERT INTO attachments(incident_id,uploaded_by,object_key,file_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,incident_id AS "incidentId",file_name AS "fileName",mime_type AS "mimeType",size_bytes::int AS size,created_at AS "createdAt"`,
        [incident.id, req.auth!.userId, key, fileName, mime, data.length],
      );
      res.status(201).json(result.rows[0]);
    }),
  );
  api.get(
    "/incidents/:id/attachments/:attachmentId",
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      const result = await pool.query(
        "SELECT object_key,file_name,mime_type FROM attachments WHERE id=$1 AND incident_id=$2",
        [uuid(req.params.attachmentId, "attachmentId"), incident.id],
      );
      const attachment = result.rows[0];
      if (!attachment)
        throw new AppError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      try {
        const data = await readFile(
          path.resolve(config.uploadDirectory, attachment.object_key),
        );
        res
          .type(attachment.mime_type)
          .setHeader(
            "content-disposition",
            `inline; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
          );
        res.send(data);
      } catch {
        throw new AppError(
          404,
          "ATTACHMENT_NOT_FOUND",
          "Attachment content not found",
        );
      }
    }),
  );
  api.post(
    "/incidents/:id/rating",
    authenticate,
    route(async (req, res) => {
      const incident = await visibleIncident(req);
      if (
        req.auth!.role !== "requester" ||
        incident.requesterId !== req.auth!.userId
      )
        throw new AppError(
          403,
          "INCIDENT_OWNER_REQUIRED",
          "Only the requester can rate this incident",
        );
      if (incident.status !== "resolved")
        throw new AppError(
          409,
          "INCIDENT_NOT_RESOLVED",
          "Only resolved incidents can be rated",
        );
      const b = object(req.body);
      const score = Number(b.score);
      if (!Number.isInteger(score) || score < 1 || score > 5)
        throw new AppError(
          422,
          "VALIDATION_ERROR",
          "score must be an integer from 1 to 5",
          [{ field: "score" }],
        );
      try {
        const result = await pool.query(
          `INSERT INTO ratings(incident_id,author_id,score,comment) VALUES($1,$2,$3,$4) RETURNING id,incident_id AS "incidentId",score,comment,created_at AS "createdAt"`,
          [
            incident.id,
            req.auth!.userId,
            score,
            optionalString(b.comment, "comment") ?? null,
          ],
        );
        res.status(201).json(result.rows[0]);
      } catch (error: any) {
        if (error?.code === "23505")
          throw new AppError(
            409,
            "RATING_ALREADY_EXISTS",
            "Incident has already been rated",
          );
        throw error;
      }
    }),
  );

  api.patch(
    "/incidents/:id/priority",
    authenticate,
    manager,
    route(async (req, res) => {
      const b = object(req.body),
        priority = oneOf(b.priority, priorities, "priority"),
        reason = string(b.reason, "reason"),
        version = Number(b.version);
      if (!Number.isInteger(version))
        throw new AppError(422, "VERSION_REQUIRED", "version is required");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT priority,version FROM incidents WHERE id=$1 FOR UPDATE",
          [uuid(req.params.id, "id")],
        );
        if (!current.rowCount)
          throw new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
        const old = current.rows[0];
        if (old.version !== version)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Incident was modified by another request",
          );
        if (old.priority === priority)
          throw new AppError(
            409,
            "PRIORITY_UNCHANGED",
            "Priority is unchanged",
          );
        await client.query(
          "UPDATE incidents SET priority=$2,version=version+1,updated_at=now() WHERE id=$1",
          [req.params.id, priority],
        );
        await client.query(
          "INSERT INTO priority_history(incident_id,previous_priority,new_priority,changed_by,reason) VALUES($1,$2,$3,$4,$5)",
          [req.params.id, old.priority, priority, req.auth!.userId, reason],
        );
        await client.query("COMMIT");
        const result = await pool.query(`${incidentSelect} WHERE i.id=$1`, [
          req.params.id,
        ]);
        res.json(result.rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }),
  );
  api.patch(
    "/incidents/:id/assignee",
    authenticate,
    manager,
    route(async (req, res) => {
      const b = object(req.body),
        assigneeId = uuid(b.assigneeId, "assigneeId"),
        reason = string(b.reason, "reason"),
        version = Number(b.version);
      if (!Number.isInteger(version))
        throw new AppError(422, "VERSION_REQUIRED", "version is required");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const eligible = await client.query(
          "SELECT 1 FROM users WHERE id=$1 AND role='manager' AND active",
          [assigneeId],
        );
        if (!eligible.rowCount)
          throw new AppError(
            422,
            "INVALID_ASSIGNEE",
            "Assignee must be an active manager",
          );
        const current = await client.query(
          "SELECT assignee_id,version FROM incidents WHERE id=$1 FOR UPDATE",
          [uuid(req.params.id, "id")],
        );
        if (!current.rowCount)
          throw new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
        const old = current.rows[0];
        if (old.version !== version)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Incident was modified by another request",
          );
        if (old.assignee_id === assigneeId)
          throw new AppError(
            409,
            "ASSIGNEE_UNCHANGED",
            "Assignee is unchanged",
          );
        await client.query(
          "UPDATE incidents SET assignee_id=$2,version=version+1,updated_at=now() WHERE id=$1",
          [req.params.id, assigneeId],
        );
        await client.query(
          "INSERT INTO assignment_history(incident_id,previous_assignee_id,new_assignee_id,changed_by,reason) VALUES($1,$2,$3,$4,$5)",
          [
            req.params.id,
            old.assignee_id,
            assigneeId,
            req.auth!.userId,
            reason,
          ],
        );
        await client.query("COMMIT");
        const result = await pool.query(`${incidentSelect} WHERE i.id=$1`, [
          req.params.id,
        ]);
        res.json(result.rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }),
  );
  api.post(
    "/incidents/:id/transitions",
    authenticate,
    manager,
    route(async (req, res) => {
      const b = object(req.body),
        to = oneOf(b.to, statuses, "to"),
        observation = optionalString(b.observation, "observation"),
        solution = optionalString(b.solution, "solution"),
        version = Number(b.version);
      if (!Number.isInteger(version))
        throw new AppError(422, "VERSION_REQUIRED", "version is required");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT status,version FROM incidents WHERE id=$1 FOR UPDATE",
          [uuid(req.params.id, "id")],
        );
        if (!current.rowCount)
          throw new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
        const old = current.rows[0];
        if (old.version !== version)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Incident was modified by another request",
          );
        validateTransition(
          old.status as IncidentStatus,
          to,
          observation,
          solution,
        );
        await client.query(
          `UPDATE incidents SET status=$2,solution=CASE WHEN $2='resolved' THEN $3 ELSE NULL END,resolved_by=CASE WHEN $2='resolved' THEN $4 ELSE NULL END,resolved_at=CASE WHEN $2='resolved' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1`,
          [req.params.id, to, solution ?? null, req.auth!.userId],
        );
        await client.query(
          "INSERT INTO status_history(incident_id,previous_status,new_status,changed_by,observation) VALUES($1,$2,$3,$4,$5)",
          [
            req.params.id,
            old.status,
            to,
            req.auth!.userId,
            observation ?? null,
          ],
        );
        await client.query("COMMIT");
        const result = await pool.query(`${incidentSelect} WHERE i.id=$1`, [
          req.params.id,
        ]);
        res.json(result.rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }),
  );
  api.get(
    "/dashboard/summary",
    authenticate,
    manager,
    route(async (req, res) => {
      const values: unknown[] = [];
      let filter = "";
      if (req.query.createdFrom) {
        values.push(string(req.query.createdFrom, "createdFrom"));
        filter += ` AND created_at >= $${values.length}`;
      }
      if (req.query.createdTo) {
        values.push(string(req.query.createdTo, "createdTo"));
        filter += ` AND created_at <= $${values.length}`;
      }
      const [status, category, priority, resolution, ratings] =
        await Promise.all([
          pool.query(
            `SELECT status AS key,count(*)::int AS count FROM incidents WHERE true ${filter} GROUP BY status`,
            values,
          ),
          pool.query(
            `SELECT c.id,c.name,count(*)::int AS count FROM incidents i JOIN categories c ON c.id=i.category_id WHERE true ${filter.replaceAll("created_at", "i.created_at")} GROUP BY c.id,c.name`,
            values,
          ),
          pool.query(
            `SELECT priority AS key,count(*)::int AS count FROM incidents WHERE true ${filter} GROUP BY priority`,
            values,
          ),
          pool.query(
            `SELECT avg(extract(epoch FROM (resolved_at-created_at)))::float8 AS "averageResolutionSeconds" FROM incidents WHERE status='resolved' ${filter}`,
            values,
          ),
          pool.query(
            `SELECT avg(r.score)::float8 AS average,json_object_agg(r.score,r.count) AS distribution FROM (SELECT score,count(*)::int AS count FROM ratings GROUP BY score) r`,
          ),
        ]);
      res.json({
        byStatus: status.rows,
        byCategory: category.rows,
        byPriority: priority.rows,
        averageResolutionSeconds: resolution.rows[0].averageResolutionSeconds,
        overdue: null,
        ratings: ratings.rows[0],
      });
    }),
  );

  app.use("/api/v1", api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export default createApp();
