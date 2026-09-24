import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { QueryBoolean, Trim } from '../../common/validation.js';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Beverages' })
  @Trim()
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({
    description: 'Parent category id; omit for a top-level category',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'null moves the category to the top level',
  })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'false deactivates the category' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryTreeQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeInactive?: boolean;
}

export class CategoryNodeDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true, type: String }) parentId:
    string | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: () => [CategoryNodeDto] }) children: CategoryNodeDto[];
}
