import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateNested } from 'class-validator';
import pg from 'pg';
import { Body, Controller, createParamDecorator, type ExecutionContext, Get, Inject, Injectable, Put, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { guardPool, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';

/**
 * MS.G.Customers (contract/ms-g-customers.openapi.yaml 1.1.0): el perfil del cliente de NUESTRA web (para autocompletar el
 * checkout) y su asistencia predeterminada (dato de salud). Un perfil por dueño (`X-Owner-Id` = `sub` del usuario); un dueño de
 * partner recibe 403 (Booking no gestiona cuentas de cliente). Base propia `customers`, tabla `profiles`.
 */
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AssistanceDto {
  @IsIn(['WCHR', 'WCHS', 'WCHC', 'BLND', 'DEAF', 'DPNA', 'MEDA']) type!: string;
  @IsOptional() @IsBoolean() needsCompanion?: boolean;
  @IsOptional() @IsString() @MaxLength(200) notes?: string;
}

class ContactDto {
  @IsEmail() @MaxLength(254) email!: string;
  @Matches(/^\+[1-9][0-9]{7,14}$/) phone!: string;
}

export class ProfileDto {
  @IsString() @Length(1, 60) @Matches(/\S/) firstName!: string;
  @IsString() @Length(1, 60) @Matches(/\S/) lastName!: string;
  @IsIn(['PASSPORT', 'NATIONAL_ID']) documentType!: string;
  @IsString() @Length(5, 20) documentNumber!: string;
  @Matches(/^[A-Z]{2}$/) nationality!: string;
  @IsOptional() @Matches(DATE) documentExpiryDate?: string;
  @Matches(DATE) birthDate!: string;
  @IsIn(['M', 'F', 'X']) gender!: string;
  @ValidateNested() @Type(() => ContactDto) contact!: ContactDto;
  @IsOptional() @ValidateNested() @Type(() => AssistanceDto) defaultAssistance?: AssistanceDto;
}

export type Profile = ProfileDto & { updatedAt: string };

export const PROFILES_STORE = Symbol('PROFILES_STORE');

export interface ProfilesStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  get(ownerId: string): Promise<Profile | undefined>;
  /** `true` si lo creó (no existía). */
  put(ownerId: string, profile: Profile): Promise<boolean>;
}

export class InMemoryProfilesStore implements ProfilesStore {
  readonly kind = 'memory' as const;
  private readonly profiles = new Map<string, Profile>();
  async init() {}
  async ping() {
    return true;
  }
  async close() {}
  async get(ownerId: string) {
    return structuredClone(this.profiles.get(ownerId));
  }
  async put(ownerId: string, profile: Profile) {
    const created = !this.profiles.has(ownerId);
    this.profiles.set(ownerId, structuredClone(profile));
    return created;
  }
}

export class PostgresProfilesStore implements ProfilesStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = guardPool(new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 }), 'ms-g-customers');
  }
  async init() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS profiles (owner_id uuid PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL)');
  }
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }
  async close() {
    await this.pool.end();
  }
  async get(ownerId: string) {
    return ((await this.pool.query('SELECT data FROM profiles WHERE owner_id = $1', [ownerId])).rows[0] as { data: Profile } | undefined)?.data;
  }
  async put(ownerId: string, profile: Profile) {
    // xmax = 0 solo en una fila recién insertada: distingue crear (201) de reemplazar (200) en una sola sentencia.
    const { rows } = await this.pool.query(
      `INSERT INTO profiles (owner_id, data, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at RETURNING (xmax = 0) AS created`,
      [ownerId, JSON.stringify(profile), profile.updatedAt],
    );
    return Boolean((rows[0] as { created: boolean }).created);
  }
}

/** Dueño = `sub` del usuario web; un partner → 403; falta o no es UUID → 400. */
const Owner = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const owner = context.switchToHttp().getRequest<Request>().header('x-owner-id');
  if (owner?.startsWith('partner:')) throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: 'El perfil de cliente es solo de la web de EcoAirlines.' });
  if (!owner || !UUID.test(owner)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Falta X-Owner-Id o no es un UUID.', invalidParams: [{ name: 'X-Owner-Id', reason: 'sub del usuario' }] });
  return owner.toLowerCase();
});

@Injectable()
export class ProfilesService {
  constructor(@Inject(PROFILES_STORE) private readonly store: ProfilesStore) {}

  async get(ownerId: string): Promise<Profile> {
    const profile = await this.store.get(ownerId);
    if (!profile) throw new ProblemDetailsException({ status: 404, code: 'PROFILE_NOT_FOUND', title: 'El cliente aún no tiene perfil.' });
    return profile;
  }

  /** Crea o reemplaza el perfil completo. */
  async put(ownerId: string, input: ProfileDto): Promise<{ profile: Profile; created: boolean }> {
    const profile: Profile = { ...input, documentNumber: input.documentNumber.replace(/[\s.-]/g, '').toUpperCase(), updatedAt: new Date().toISOString() };
    return { profile, created: await this.store.put(ownerId, profile) };
  }
}

/** Operaciones de MS.G.Customers. Solo el ESB, con su token de servicio. */
@Controller('profile')
@UseGuards(ServiceTokenGuard)
export class ProfilesController {
  constructor(@Inject(ProfilesService) private readonly profiles: ProfilesService) {}

  @Get()
  get(@Owner() owner: string) {
    return this.profiles.get(owner);
  }

  @Put()
  async put(@Body() body: ProfileDto, @Owner() owner: string, @Res({ passthrough: true }) response: Response) {
    const { profile, created } = await this.profiles.put(owner, body);
    response.status(created ? 201 : 200);
    return profile;
  }
}
