import { IsOptional, IsString, IsArray, IsBoolean, IsNumber, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

/**
 * LinkedIn company size codes → employee ranges.
 *
 * A = Self-employed (1)
 * B = 1–10
 * C = 11–50
 * D = 51–200
 * E = 201–500
 * F = 501–1,000
 * G = 1,001–5,000
 * H = 5,001–10,000
 * I = 10,001+
 */
export const COMPANY_SIZE_LABELS: Record<string, string> = {
  A: 'Self-employed',
  B: '1–10',
  C: '11–50',
  D: '51–200',
  E: '201–500',
  F: '501–1,000',
  G: '1,001–5,000',
  H: '5,001–10,000',
  I: '10,001+',
};

/**
 * LinkedIn company type codes.
 *
 * C = Public company
 * D = Self-employed
 * E = Non-profit
 * F = Partnership
 * G = Privately held
 * H = Educational institution
 * I = Government agency
 * J = Sole proprietorship
 */
export const COMPANY_TYPE_LABELS: Record<string, string> = {
  C: 'Public company',
  D: 'Self-employed',
  E: 'Non-profit',
  F: 'Partnership',
  G: 'Privately held',
  H: 'Educational institution',
  I: 'Government agency',
  J: 'Sole proprietorship',
};

/**
 * LinkedIn company search uses "industryCompanyVertical" with exactly 5 broad categories.
 * These IDs were extracted directly from LinkedIn's filter panel HTML (June 2026).
 * The old specific industry IDs (10=Marketing, 53=Telecom, etc.) no longer apply to
 * company search — LinkedIn collapsed its full taxonomy into these 5 super-categories.
 */
export const COMMON_INDUSTRIES: Record<string, string> = {
  '6':    'Tecnología, información e internet',
  '1594': 'Tecnología, información y medios de comunicación',
  '43':   'Servicios financieros',
  '1810': 'Servicios profesionales',
  '25':   'Industria manufacturera',
};

export class SearchCompaniesDto {
  @ApiPropertyOptional({ example: 'fintech', description: 'Company name or keyword' })
  @IsOptional()
  @IsString()
  keywords?: string;

  @ApiPropertyOptional({ example: 'Spain', description: 'Headquarters location (city or country)' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: '90010', description: 'LinkedIn geoId (overrides location)' })
  @IsOptional()
  @IsString()
  geoId?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['C', 'D', 'E'],
    description: 'Employee count ranges: A=self-employed, B=1-10, C=11-50, D=51-200, E=201-500, F=501-1k, G=1k-5k, H=5k-10k, I=10k+',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? [value] : value))
  companySize?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['43', '5'],
    description: 'LinkedIn industry IDs. Common: 43=IT&Services, 6=Financial, 5=Internet, 3=Software, 7=Banking',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? [value] : value))
  industry?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['G', 'C'],
    description: 'Company type: C=Public, D=Self-employed, E=Non-profit, F=Partnership, G=Privately held, H=Educational, I=Government, J=Sole proprietorship',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? [value] : value))
  companyType?: string[];

  @ApiPropertyOptional({ example: true, description: 'Only return companies with active job listings' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  hasJobListings?: boolean;

  @ApiPropertyOptional({ example: 25, description: 'Max results to return (default 25, max 100)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class SearchPeopleAtCompanyDto {
  @ApiPropertyOptional({ example: 'engineer', description: 'Role or keyword filter within the company' })
  @IsOptional()
  @IsString()
  keywords?: string;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}
