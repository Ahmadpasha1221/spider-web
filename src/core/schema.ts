import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

import sessionSchema from "../../schemas/spider-session.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/spider-egg-manifest.schema.json" with { type: "json" };
import type { SpiderSession10Draft } from "../generated/spider-session.js";
import type { SpiderEggManifest01 } from "../generated/spider-egg-manifest.js";

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: <T>(schema: unknown) => ValidateFunction<T>;
};

const Ajv2020 = (
  Ajv2020Module as unknown as {
    default: AjvConstructor;
  }
).default;

const addFormats = (
  addFormatsModule as unknown as {
    default: (ajv: unknown) => void;
  }
).default;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});

addFormats(ajv);

export const validateSessionShape =
  ajv.compile<SpiderSession10Draft>(sessionSchema);

export const validateManifestShape =
  ajv.compile<SpiderEggManifest01>(manifestSchema);

export class ContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, errors: readonly ErrorObject[] = []) {
    const issues = errors.map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    );

    super(
      issues.length > 0
        ? `${label} is invalid:\n- ${issues.join("\n- ")}`
        : `${label} is invalid`,
    );

    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function assertSchema<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
): asserts value is T {
  if (!validator(value)) {
    throw new ContractValidationError(label, validator.errors ?? []);
  }
}
