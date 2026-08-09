import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsIn,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type as TransformType } from 'class-transformer';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { PortfolioService } from './portfolio.service';

export class MoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a decimal string' })
  amount!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;
}

export class PortfolioEntryInputDto {
  @IsUUID()
  property_id!: string;

  @IsNotEmptyObject()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  purchase_price!: MoneyDto;

  @IsNotEmptyObject()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  monthly_rental_income!: MoneyDto;

  @IsNotEmptyObject()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  monthly_expenses!: MoneyDto;

  @IsOptional()
  @IsIn(['watching', 'offer_made', 'owned'])
  status?: 'watching' | 'offer_made' | 'owned';
}

export class PortfolioEntryUpdateDto {
  @IsOptional()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  purchase_price?: MoneyDto;

  @IsOptional()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  monthly_rental_income?: MoneyDto;

  @IsOptional()
  @ValidateNested()
  @TransformType(() => MoneyDto)
  monthly_expenses?: MoneyDto;

  @IsOptional()
  @IsIn(['watching', 'offer_made', 'owned'])
  status?: 'watching' | 'offer_made' | 'owned';
}

@Controller('me/portfolio')
export class PortfolioController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.portfolio.list(
      await this.contactId(req),
      cursor,
      Math.min(parseInt(limit ?? '25', 10) || 25, 100),
    );
  }

  @Post()
  async add(@Req() req: AuthedRequest, @Body() body: PortfolioEntryInputDto) {
    return this.portfolio.add(await this.contactId(req), body);
  }

  @Patch(':propertyId')
  async update(
    @Req() req: AuthedRequest,
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() body: PortfolioEntryUpdateDto,
  ) {
    return this.portfolio.update(await this.contactId(req), propertyId, body);
  }

  @Delete(':propertyId')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    await this.portfolio.remove(await this.contactId(req), propertyId);
  }
}
