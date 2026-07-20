import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CreateTemplateDto } from './templates.service';
import { TemplatesService } from './templates.service';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a message template',
    description: 'Use {name}, {company}, {title}, {role} or any {variable} as placeholders.',
  })
  create(@Body() body: CreateTemplateDto) {
    return this.templates.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'List all templates' })
  findAll() {
    return this.templates.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single template' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.templates.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a template' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.templates.delete(id);
  }
}
