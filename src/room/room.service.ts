import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Room } from './entities/room.entity';
import { CreateRoomDto, UpdateRoomDto, RoomQueryDto } from './dtos/room.dto';
import { RedisCacheService } from 'src/redis/redid-cache.service';

@Injectable()
export class RoomService implements OnModuleInit {
  constructor(
    @InjectRepository(Room)
    private readonly roomRepo: Repository<Room>,
    private readonly redisCacheService: RedisCacheService,
  ) {}

  async onModuleInit() {
    try {
      await this.roomRepo.query(
        "ALTER TABLE `rooms` ADD COLUMN `status` VARCHAR(255) NULL DEFAULT 'UC'",
      );
      console.log('Successfully added status column to rooms table in MySQL');
    } catch (err: any) {
      if (
        !err?.message?.includes('Duplicate column name') &&
        !err?.code?.includes('1060') &&
        err?.errno !== 1060
      ) {
        console.warn('Note on rooms status column:', err?.message || err);
      }
    }

    try {
      await this.redisCacheService.deleteByPattern('rooms:*');
    } catch (e) {
      // Ignore cache clear error on init
    }
  }

  async create(createRoomDto: CreateRoomDto): Promise<Room> {
    const room = this.roomRepo.create(createRoomDto);
    const savedRoom = await this.roomRepo.save(room);
    await this.redisCacheService.deleteByPattern('rooms:*');
    return savedRoom;
  }

  async findAll(query: RoomQueryDto): Promise<any> {
    const { page = 1, limit = 10, isExport = false, flid, search, status } = query;
    return this.redisCacheService.getOrSet(
      `rooms:list:${flid ?? 'all'}:${search ?? 'all'}:${status ?? 'all'}:${isExport}:${page}:${limit}`,
      async () => {
        const where: any = {};
        if (flid !== undefined && flid !== null) {
          where.fl_id = flid;
        }
        if (search) {
          where.room_name = Like(`%${search}%`);
        }
        if (status) {
          where.status = status;
        }
        
        const findOptions: any = {
          where,
          relations: { floor: true },
          order: { room_id: 'DESC' },
        };
        if (!isExport) {
          findOptions.take = limit;
          findOptions.skip = (page - 1) * limit;
        }
        const [rooms, total] = await this.roomRepo.findAndCount(findOptions);
        if (total === 0) {
          return { message: 'No Rooms Found', data: [], total: 0 };
        }
        return {
          data: rooms,
          total,
          page: isExport ? 1 : page,
          limit: isExport ? total : limit,
          totalPages: isExport ? 1 : Math.ceil(total / limit),
        };
      },
      1000 * 60 * 5,
    );
  }

  async findOne(room_id: number): Promise<Room | null> {
    return this.redisCacheService.getOrSet(
      `rooms:detail:${room_id}`,
      async () => {
        return await this.roomRepo.findOne({
          where: { room_id },
          relations: { floor: true },
        });
      },
      1000 * 60 * 10,
    );
  }

  async update(room_id: number, updateRoomDto: UpdateRoomDto): Promise<Room | null> {
    await this.roomRepo.update(room_id, updateRoomDto);
    await this.redisCacheService.deleteByPattern('rooms:*');
    return await this.findOne(room_id);
  }

  async remove(room_id: number): Promise<Room | null> {
    const room = await this.findOne(room_id);
    if (room) {
      await this.roomRepo.delete(room_id);
      await this.redisCacheService.deleteByPattern('rooms:*');
    }
    return room;
  }

  async getStatusCounts(): Promise<any> {
    return this.redisCacheService.getOrSet(
      'rooms:status:counts',
      async () => {
        const counts = await this.roomRepo
          .createQueryBuilder('rooms')
          .select(
            "SUM(CASE WHEN rooms.status = 'UC' OR rooms.status IS NULL THEN 1 ELSE 0 END)",
            'ucCount',
          )
          .addSelect(
            "SUM(CASE WHEN rooms.status = 'C' THEN 1 ELSE 0 END)",
            'cCount',
          )
          .addSelect(
            "SUM(CASE WHEN rooms.status = 'HO' THEN 1 ELSE 0 END)",
            'hoCount',
          )
          .getRawOne();

        return {
          statusCode: 200,
          data: {
            UC: Number(counts.ucCount || 0),
            C: Number(counts.cCount || 0),
            HO: Number(counts.hoCount || 0),
          },
        };
      },
      1000 * 60 * 5,
    );
  }
}
