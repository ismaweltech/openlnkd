import { IsString, IsNotEmpty, IsInt, IsArray, ArrayNotEmpty, IsOptional, IsBoolean, IsNumber } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCampaignDto {
  @ApiProperty({ example: 'CTO outreach', description: 'Campaign name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 1, description: 'ID of the template to send' })
  @Type(() => Number)
  @IsInt()
  templateId: number;

  @ApiProperty({ type: [String], description: 'LinkedIn profile URLs to message' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  profileUrls: string[];

  @ApiPropertyOptional({ example: 30, description: 'Min seconds between sends (default 30)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  delayMin?: number;

  @ApiPropertyOptional({ example: 90, description: 'Max seconds between sends (default 90)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  delayMax?: number;

  @ApiPropertyOptional({ example: true, description: 'Skip profiles that are not 1st-degree connections' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  filterConnections?: boolean;
}
