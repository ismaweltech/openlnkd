import { IsOptional, IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const LINKEDIN_PROFILE = /linkedin\.com\/in\//i;

export class SendInviteDto {
  @ApiProperty({ example: 'https://www.linkedin.com/in/someone/', description: 'LinkedIn profile URL' })
  @IsString()
  @IsNotEmpty()
  @Matches(LINKEDIN_PROFILE, { message: 'profileUrl must be a LinkedIn /in/ profile URL' })
  profileUrl: string;

  @ApiPropertyOptional({ description: 'Optional note (max 300 chars)', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  message?: string;
}

export class SendMessageDto {
  @ApiProperty({ example: 'https://www.linkedin.com/in/someone/', description: 'LinkedIn profile URL' })
  @IsString()
  @IsNotEmpty()
  @Matches(LINKEDIN_PROFILE, { message: 'profileUrl must be a LinkedIn /in/ profile URL' })
  profileUrl: string;

  @ApiProperty({ description: 'Message body to send' })
  @IsString()
  @IsNotEmpty()
  message: string;
}
