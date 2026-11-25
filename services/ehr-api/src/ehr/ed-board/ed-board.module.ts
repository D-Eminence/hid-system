import { Module } from '@nestjs/common';
import { EdBoardController } from './ed-board.controller';
import { EdBoardService } from './ed-board.service';

/** ED-1 (0168, 0169): the emergency department board, behind ED_BOARD_ENABLED. */
@Module({
  controllers: [EdBoardController],
  providers: [EdBoardService],
})
export class EdBoardModule {}
