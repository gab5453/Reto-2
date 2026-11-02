import { Inject, Injectable } from '@nestjs/common';
import { AIRCRAFT_LAYOUTS, ProblemDetailsException } from '@ecoairlines/shared';
import { SCHEDULE_CONFIG, type ScheduleConfig } from '../config/config.js';
import { localDateOf } from '../domain/dates.js';
import type { CabinClass, PromotionAgreementRecord, PromotionTerms } from '../domain/model.js';
import { assertPromotionTerms } from '../domain/rules.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';
import { ScheduleService } from './schedule.service.js';

/**
 * Acuerdo de promociones B2B (D35, contrato v2 `GET/PUT /vuelos/promociones/contrato`). Lo define el administrador en
 * «Precios por clase»: un solo descuento máximo de 0 a 50 %. El partner solo lo consulta.
 */
@Injectable()
export class PromotionsService {
  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    @Inject(SCHEDULE_CONFIG) private readonly config: ScheduleConfig,
  ) {}

  async get(partnerId: string) {
    const agreement = await this.repository.getAgreement(partnerId);
    if (!agreement) throw ProblemDetailsException.notFound(`Todavía no hay un acuerdo de promociones con ${partnerId}.`);
    return this.toResponse(agreement);
  }

  /** Reemplaza el acuerdo completo (lo que no se envía queda sin valor). */
  async save(partnerId: string, terms: PromotionTerms, actor: string) {
    const cabins = new Set<CabinClass>(Object.values(AIRCRAFT_LAYOUTS).flatMap((layout) => layout.map((cabin) => cabin.cabinClass)));
    assertPromotionTerms(terms, {
      routes: await this.schedule.operatedRoutes(),
      cabins,
      today: localDateOf(Date.now(), this.config.utcOffsetMinutes),
    });
    const agreement: PromotionAgreementRecord = {
      partnerId,
      permite_promociones: terms.permite_promociones,
      porcentaje_descuento_maximo: terms.porcentaje_descuento_maximo,
      ...(terms.destinos_habilitados ? { destinos_habilitados: [...new Set(terms.destinos_habilitados)] } : {}),
      ...(terms.rutas_habilitadas ? { rutas_habilitadas: [...new Set(terms.rutas_habilitadas)] } : {}),
      ...(terms.cabinas_habilitadas ? { cabinas_habilitadas: [...new Set(terms.cabinas_habilitadas)] } : {}),
      ...(terms.vigencia_hasta ? { vigencia_hasta: terms.vigencia_hasta } : {}),
      ...(terms.condiciones_combo !== undefined ? { condiciones_combo: terms.condiciones_combo } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.repository.saveAgreement(agreement);
    return this.toResponse(agreement);
  }

  /**
   * Acuerdo inicial con un partner: sin promociones (0 %). Así Booking recibe "no hay promoción" en vez de 404 hasta que el
   * administrador lo cambie. Solo se crea si no existe (nunca pisa lo que guardó el administrador).
   */
  async seedWithoutPromotions(partnerId: string): Promise<void> {
    if (await this.repository.getAgreement(partnerId)) return;
    await this.repository.saveAgreement({
      partnerId,
      permite_promociones: false,
      porcentaje_descuento_maximo: 0,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    });
  }

  /** Forma `ContratoPromocionesResponse` del contrato v2. */
  private toResponse(agreement: PromotionAgreementRecord) {
    const terms: Partial<PromotionAgreementRecord> = { ...agreement };
    delete terms.partnerId;
    delete terms.updatedAt;
    delete terms.updatedBy;
    return { proveedor_codigo: this.config.providerCode, nombre_socio: 'EcoAirlines', vertical: 'VUELOS', actualizado_en: agreement.updatedAt, ...terms };
  }
}
