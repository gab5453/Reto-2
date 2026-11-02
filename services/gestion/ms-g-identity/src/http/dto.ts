import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { AccountStatus, RoleName } from '../domain/model.js';

/** DTO de los esquemas de contract/ms-g-identity.openapi.yaml (`additionalProperties: false` lo aplica el ValidationPipe). */
const ROLE_NAMES: RoleName[] = ['CUSTOMER', 'ADMIN'];
const STATUSES: AccountStatus[] = ['ACTIVE', 'BLOCKED'];
const NOT_BLANK = /\S/;
/** El contrato guarda el correo sin espacios: se recortan antes de validar el formato. */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @IsString() @Length(1, 80) @Matches(NOT_BLANK, { message: 'fullName no puede estar vacío' })
  fullName!: string;

  @Transform(trim) @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @Length(8, 128)
  password!: string;
}

export class LoginDto {
  @Transform(trim) @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @MaxLength(128)
  password!: string;
}

export class CreateUserDto extends RegisterDto {
  @IsIn(ROLE_NAMES)
  role!: RoleName;
}

export class ChangeRoleDto {
  @IsIn(ROLE_NAMES)
  role!: RoleName;
}

export class ChangeStatusDto {
  @IsIn(STATUSES)
  status!: AccountStatus;

  @IsOptional() @IsString() @MaxLength(200)
  reason?: string;
}

export class CreatePartnerDto {
  @Matches(/^[A-Z][A-Z0-9_]{2,39}$/, { message: 'clientId: mayúsculas, dígitos y guion bajo (3 a 40 caracteres)' })
  clientId!: string;

  @IsString() @Length(1, 80) @Matches(NOT_BLANK, { message: 'name no puede estar vacío' })
  name!: string;

  // Que cada scope sea un PartnerScope lo valida la regla de dominio, con un mensaje propio.
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsString({ each: true })
  scopes?: string[];
}

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

export class ListUsersQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(80)
  q?: string;

  @IsOptional() @IsIn(ROLE_NAMES)
  role?: RoleName;

  @IsOptional() @IsIn(STATUSES)
  status?: AccountStatus;
}

export class ListPartnersQuery extends PageQuery {
  @IsOptional() @IsIn(STATUSES)
  status?: AccountStatus;
}
