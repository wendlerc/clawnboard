import { describe, it, expect } from "vitest";
import { VM_SPECS } from "./constants.js";

describe("Constants", () => {
  describe("VM_SPECS", () => {
    it("should have all size options", () => {
      expect(VM_SPECS).toHaveProperty("1gb");
      expect(VM_SPECS).toHaveProperty("2gb");
      expect(VM_SPECS).toHaveProperty("4gb");
    });

    it("should have increasing memory for larger sizes", () => {
      expect(VM_SPECS["2gb"].memoryMb).toBeGreaterThan(VM_SPECS["1gb"].memoryMb);
      expect(VM_SPECS["4gb"].memoryMb).toBeGreaterThan(VM_SPECS["2gb"].memoryMb);
    });

    it("should have 1 CPU for all sizes", () => {
      expect(VM_SPECS["1gb"].cpus).toBe(1);
      expect(VM_SPECS["2gb"].cpus).toBe(1);
      expect(VM_SPECS["4gb"].cpus).toBe(1);
    });

    it("should have labels and descriptions for each size", () => {
      for (const spec of Object.values(VM_SPECS)) {
        expect(spec).toHaveProperty("label");
        expect(spec).toHaveProperty("description");
        expect(spec).toHaveProperty("pricePerMonth");
        expect(typeof spec.label).toBe("string");
        expect(typeof spec.description).toBe("string");
      }
    });

    it("should label 2gb as the mid tier", () => {
      expect(VM_SPECS["2gb"].label).toContain("2GB");
    });
  });
});
