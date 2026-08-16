// DOC-02 — Cadastro: ORGANIZAÇÃO (§5.1, DE TENANT) + ESTRUTURA FÍSICA (§5.2, GLOBAL).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';

import { WarehouseController } from './warehouse/warehouse.controller.js';
import { WarehouseService } from './warehouse/warehouse.service.js';
import { ZoneController } from './zone/zone.controller.js';
import { ZoneService } from './zone/zone.service.js';
import { StorageEquipmentController } from './storage-equipment/storage-equipment.controller.js';
import { StorageEquipmentService } from './storage-equipment/storage-equipment.service.js';
import { DockController } from './dock/dock.controller.js';
import { DockService } from './dock/dock.service.js';
import { YardSlotController } from './yard-slot/yard-slot.controller.js';
import { YardSlotService } from './yard-slot/yard-slot.service.js';
import { LocationController } from './location/location.controller.js';
import { LocationService } from './location/location.service.js';
import { ClientController } from './client/client.controller.js';
import { ClientService } from './client/client.service.js';
import { ClientWarehouseSettingsController } from './client-warehouse-settings/client-warehouse-settings.controller.js';
import { ClientWarehouseSettingsService } from './client-warehouse-settings/client-warehouse-settings.service.js';
import { LogicalWarehouseController } from './logical-warehouse/logical-warehouse.controller.js';
import { LogicalWarehouseService } from './logical-warehouse/logical-warehouse.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    WarehouseController,
    ZoneController,
    StorageEquipmentController,
    DockController,
    YardSlotController,
    LocationController,
    ClientController,
    ClientWarehouseSettingsController,
    LogicalWarehouseController,
  ],
  providers: [
    WarehouseService,
    ZoneService,
    StorageEquipmentService,
    DockService,
    YardSlotService,
    LocationService,
    ClientService,
    ClientWarehouseSettingsService,
    LogicalWarehouseService,
  ],
})
export class CadastroModule {}
