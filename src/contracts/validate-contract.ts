import { ClassConstructor, plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { InvalidRequestError } from '../application/errors/application.error';

export function validateContract<T extends object>(contract: ClassConstructor<T>, input: unknown): T {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidRequestError('Payload must be a JSON object');
  }

  const instance = plainToInstance(contract, input);
  const errors = validateSync(instance, { whitelist: true, forbidUnknownValues: true });

  if (errors.length > 0) {
    throw new InvalidRequestError('Invalid payload', flatten(errors));
  }

  return instance;
}

function flatten(errors: ValidationError[], path = ''): string[] {
  return errors.flatMap((error) => {
    const property = path ? `${path}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => message.replace(error.property, property));

    return [...own, ...flatten(error.children ?? [], property)];
  });
}
