import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import sessionSchema from "../../schemas/spider-session.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/spider-egg-manifest.schema.json" with { type: "json" };
import type { SpiderSession10Draft } from "../generated/spider-session.js";
import type { SpiderEggManifest01 } from "../generated/spider-egg-manifest.js";

type AjvInstance = InstanceType<typeof Ajv>;
const AjvClass = Ajv as unknown as new (options?: { allErrors?: boolean; strict?: boolean; allowUnionTypes?: boolean }) => AjvInstance;
const ajv = new AjvClass({ allErrors: true, strict: true, allowUnionTypes: true });
(addFormats as unknown as (ajv: AjvInstance) => AjvInstance)(ajv);

export const validateSessionShape = ajv.compile<SpiderSession10Draft>(sessionSchema);
export const validateManifestShape = ajv.compile<SpiderEggManifest01>(manifestSchema);

export class ContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, errors: readonly ErrorObject[] = []) {
    const issues = errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    super(issues.length > 0 ? `${label} is invalid:\n- ${issues.join("\n- ")}` : `${label} is invalid`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function assertSchema<T>(
  validator: ValidateFunction<T>, value: unknown, label: string,
): asserts value is T {
  if (!validator(value)) throw new ContractValidationError(label, validator.errors ?? []);
}
