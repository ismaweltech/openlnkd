import { IsOptional, IsString, IsNotEmpty, IsBoolean, IsNumber, IsIn } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class JobSearchDto {
  @ApiProperty({ example: 'product manager', description: 'Search keywords (required)' })
  @IsString()
  @IsNotEmpty()
  keywords: string;

  @ApiPropertyOptional({ example: 'Spain', description: 'Human-readable location (resolved to geoId)' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: '105646813', description: 'LinkedIn numeric geoId (overrides location)' })
  @IsOptional()
  @IsString()
  geoId?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  remote?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  easyApply?: boolean;

  @ApiPropertyOptional({ enum: ['past24h', 'pastWeek', 'pastMonth'] })
  @IsOptional()
  @IsIn(['past24h', 'pastWeek', 'pastMonth'])
  datePosted?: 'past24h' | 'pastWeek' | 'pastMonth';

  @ApiPropertyOptional({ example: 25, description: 'Max results (default 25)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}
