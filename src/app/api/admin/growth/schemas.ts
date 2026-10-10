import { z } from "zod";
import { GROWTH_FORMATS, GROWTH_PLATFORMS, GROWTH_ANGLES, GROWTH_PUBLISHER_IDS } from "@/lib/growth/types";
import { ENGAGE_PLATFORMS, ENGAGE_STATUSES, WATCH_KINDS } from "@/lib/growth/engage/types";

export const platformSchema = z.enum(GROWTH_PLATFORMS);
export const formatSchema = z.enum(GROWTH_FORMATS);
export const angleSchema = z.enum(GROWTH_ANGLES);
export const publisherSchema = z.enum(GROWTH_PUBLISHER_IDS);
export const uuidSchema = z.string().uuid();
export const isoSchema = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "invalid date");

export const engagePlatformSchema = z.enum(ENGAGE_PLATFORMS);
export const watchKindSchema = z.enum(WATCH_KINDS);
export const engageStatusSchema = z.enum(ENGAGE_STATUSES);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
