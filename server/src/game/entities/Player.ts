export interface Position {
  x: number;
  y: number;
  z: number;
}

export class Player {
  public id: string;
  public position: Position;
  public socketId: string;

  constructor(id: string, position: Position, socketId?: string) {
    this.id = id;
    this.position = position;
    this.socketId = socketId || '';
  }

  public updatePosition(position: Position): void {
    this.position = position;
  }

  public setSocketId(socketId: string): void {
    this.socketId = socketId;
  }
} 