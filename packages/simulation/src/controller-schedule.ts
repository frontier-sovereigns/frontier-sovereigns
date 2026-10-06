/** Deterministic offsets distribute tactical decisions without changing each
 * commander's cadence or reaction delay. Legacy 50ms saves keep their schedule. */
interface ControllerClock {tick:number;playerId:string;players:readonly {id:string}[];authoritativeIntervalMs?:number}
function offset(clock:ControllerClock,period:number):number {
  if(clock.authoritativeIntervalMs!==300)return 0;
  return Math.floor(Math.max(0,clock.players.findIndex(player=>player.id===clock.playerId))*period/Math.max(1,clock.players.length));
}
export function controllerPulse(clock:ControllerClock,period:number):boolean {
  return clock.tick%period===offset(clock,period);
}
export function controllerMemoryPulse(clock:ControllerClock,period:number,secondTicks:number):boolean {
  if(clock.authoritativeIntervalMs!==300)return clock.tick%secondTicks===0;
  return controllerPulse(clock,period)&&(clock.tick-offset(clock,period))%secondTicks<period;
}
