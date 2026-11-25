import { DurableObject } from "cloudflare:workers";

/**
 * Sessions used to live in this Durable Object. Nothing routes to it now, but
 * the class and its binding stay so a rollback to a version that uses them
 * works. Deleting it needs a `deleted_classes` migration, which can't be
 * rolled back.
 */
export class KnockMCP extends DurableObject<Env> {}
