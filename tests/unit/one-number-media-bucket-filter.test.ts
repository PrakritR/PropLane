// A PropLane Service roster job's photos are stored under the service owner's bucket path, not the client's.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bucketPathFilter } from "@/lib/one-number/inbound-media.server";

describe("bucketPathFilter", () => {
  it("matches the job owner's path and each extra media owner's, once", () => {
    expect(bucketPathFilter(["client-1", "service-1", "client-1"])).toBe("storage_path.like.manager/client-1/*,storage_path.like.manager/service-1/*");
  });

  it("never lets a comma, a paren or a wildcard into the filter", () => {
    expect(bucketPathFilter(["a),storage_path.like.(*", "ok-2"])).toBe("storage_path.like.manager/ok-2/*");
    expect(bucketPathFilter([""])).toBe("storage_path.like.manager/none/*");
  });
});
