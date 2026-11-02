import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ServiceTokenGuard } from '@ecoairlines/shared';
import { AccountsService } from '../services/accounts.service.js';
import { PartnersService } from '../services/partners.service.js';
import { ActorSub, AdminActorGuard } from './admin-actor.guard.js';
import { ChangeRoleDto, ChangeStatusDto, CreatePartnerDto, CreateUserDto, ListPartnersQuery, ListUsersQuery } from './dto.js';

/**
 * Gestión del administrador (contrato: Usuarios, Partners, Roles). Solo el ESB (token de servicio) y en nombre de un
 * ADMIN activo (`X-Actor-Id`); el orden de los guards da 401 → 403 del token → 403 del actor.
 */
@Controller()
@UseGuards(ServiceTokenGuard, AdminActorGuard)
export class AdminController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PartnersService) private readonly partners: PartnersService,
  ) {}

  @Get('users')
  listUsers(@Query() query: ListUsersQuery) {
    return this.accounts.listUsers({ q: query.q, role: query.role, status: query.status }, query.limit, query.cursor);
  }

  @Post('users')
  async createUser(@Body() body: CreateUserDto, @ActorSub() actor: string, @Res({ passthrough: true }) response: Response) {
    const user = await this.accounts.createUser(body, actor);
    response.location(`/users/${user.sub}`);
    return user;
  }

  // Antes de `users/:sub`, para que "summary" no se tome como un sub.
  @Get('users/summary')
  summary() {
    return this.accounts.summary();
  }

  @Get('users/:sub')
  getUser(@Param('sub') sub: string) {
    return this.accounts.getUser(sub);
  }

  @Put('users/:sub/role')
  changeRole(@Param('sub') sub: string, @Body() body: ChangeRoleDto, @ActorSub() actor: string) {
    return this.accounts.changeRole(sub, body.role, actor);
  }

  @Put('users/:sub/status')
  changeUserStatus(@Param('sub') sub: string, @Body() body: ChangeStatusDto, @ActorSub() actor: string) {
    return this.accounts.changeStatus(sub, body.status, actor);
  }

  @Get('partners')
  listPartners(@Query() query: ListPartnersQuery) {
    return this.partners.list(query.status, query.limit, query.cursor);
  }

  @Post('partners')
  async createPartner(@Body() body: CreatePartnerDto, @ActorSub() actor: string, @Res({ passthrough: true }) response: Response) {
    const partner = await this.partners.create(body, actor);
    response.location(`/partners/${partner.clientId}`).setHeader('Cache-Control', 'no-store');
    return partner;
  }

  @Get('partners/:clientId')
  getPartner(@Param('clientId') clientId: string) {
    return this.partners.get(clientId);
  }

  @Put('partners/:clientId/status')
  changePartnerStatus(@Param('clientId') clientId: string, @Body() body: ChangeStatusDto, @ActorSub() actor: string) {
    return this.partners.changeStatus(clientId, body.status, actor);
  }

  @Post('partners/:clientId/secret')
  @HttpCode(200)
  async rotateSecret(@Param('clientId') clientId: string, @ActorSub() actor: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.partners.rotateSecret(clientId, actor);
  }

  @Get('roles')
  roles() {
    return this.accounts.roles();
  }
}
